// Command dev-tools serves the dev-tools site from memory. The site is embedded already gzipped, and the HTTP/1.1 server is
// deliberately tiny (GET and HEAD only, no net/http) so that the container image stays about a megabyte.
//
//	dev-tools               listen on :8080 (or $PORT)
//	dev-tools -addr :9000   listen elsewhere
//	dev-tools -healthcheck  exit 0 if the local server answers /healthz (for HEALTHCHECK; the image has no shell or curl)
package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"embed"
	"errors"
	"flag"
	"hash/fnv"
	"io"
	"io/fs"
	"net"
	"net/url"
	"os"
	"os/signal"
	"path"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

//go:embed all:www
var site embed.FS

const (
	maxHeader   = 8 << 10          // request line plus headers
	idleTimeout = 30 * time.Second // between requests on a kept-alive connection
	readTimeout = 10 * time.Second // from the first byte of a request to its last header
	maxConns    = 256
)

type asset struct {
	gz    []byte
	ctype string
	etag  string
	once  sync.Once
	plain []byte // inflated lazily, for the rare client that does not accept gzip
}

var assets = map[string]*asset{}

var types = map[string]string{
	".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
	".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
	".txt": "text/plain; charset=utf-8", ".xml": "application/xml", ".xsd": "application/xml", ".woff2": "font/woff2",
}

func load() {
	err := fs.WalkDir(site, "www", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".gz") {
			return err
		}
		b, err := site.ReadFile(p)
		if err != nil {
			return err
		}
		name := "/" + strings.TrimSuffix(strings.TrimPrefix(p, "www/"), ".gz")
		ct, ok := types[path.Ext(name)]
		if !ok {
			ct = "application/octet-stream"
		}
		h := fnv.New64a()
		h.Write(b)
		assets[name] = &asset{gz: b, ctype: ct, etag: `"` + strconv.FormatUint(h.Sum64(), 36) + `"`}
		return nil
	})
	if err != nil || assets["/index.html"] == nil {
		os.Stderr.WriteString("dev-tools: embedded site is missing\n")
		os.Exit(1)
	}
	assets["/"] = assets["/index.html"]
}

func (a *asset) inflate() []byte {
	a.once.Do(func() {
		if zr, err := gzip.NewReader(bytes.NewReader(a.gz)); err == nil {
			a.plain, _ = io.ReadAll(zr)
		}
	})
	return a.plain
}

type request struct {
	method, target string
	http11         bool
	keepAlive      bool
	gzip           bool
	ifNoneMatch    string
}

var errBad = errors.New("bad request")

// readRequest parses one request head. The int is the HTTP status to answer with when it fails (0: just close).
func readRequest(c net.Conn, r *bufio.Reader) (rq request, status int, err error) {
	c.SetReadDeadline(time.Now().Add(idleTimeout))
	line, err := r.ReadSlice('\n')
	if err == bufio.ErrBufferFull {
		return rq, 414, err
	}
	if err != nil {
		return rq, 0, err
	}
	c.SetReadDeadline(time.Now().Add(readTimeout))
	parts := strings.Fields(string(line))
	if len(parts) != 3 || !strings.HasPrefix(parts[2], "HTTP/1.") {
		return rq, 400, errBad
	}
	rq.method, rq.target, rq.http11 = parts[0], parts[1], parts[2] == "HTTP/1.1"
	rq.keepAlive = rq.http11
	size := len(line)
	for {
		h, err := r.ReadSlice('\n')
		if err == bufio.ErrBufferFull {
			return rq, 431, err
		}
		if err != nil {
			return rq, 0, err
		}
		if size += len(h); size > maxHeader {
			return rq, 431, errBad
		}
		text := strings.TrimRight(string(h), "\r\n")
		if text == "" {
			return rq, 0, nil
		}
		k, v, ok := strings.Cut(text, ":")
		if !ok {
			return rq, 400, errBad
		}
		v = strings.TrimSpace(v)
		switch strings.ToLower(strings.TrimSpace(k)) {
		case "accept-encoding":
			rq.gzip = acceptsGzip(v)
		case "if-none-match":
			rq.ifNoneMatch = v
		case "connection":
			l := strings.ToLower(v)
			if strings.Contains(l, "close") {
				rq.keepAlive = false
			} else if strings.Contains(l, "keep-alive") {
				rq.keepAlive = true
			}
		case "transfer-encoding":
			return rq, 400, errBad // no request bodies: refuse anything that could smuggle one
		case "content-length":
			if v != "0" {
				return rq, 400, errBad
			}
		}
	}
}

func acceptsGzip(v string) bool {
	for _, p := range strings.Split(strings.ToLower(v), ",") {
		name, q, hasQ := strings.Cut(strings.TrimSpace(p), ";")
		if strings.TrimSpace(name) != "gzip" {
			continue
		}
		if hasQ {
			if f, err := strconv.ParseFloat(strings.TrimPrefix(strings.ReplaceAll(q, " ", ""), "q="), 64); err == nil && f == 0 {
				return false
			}
		}
		return true
	}
	return false
}

// lookup maps a request target to an asset name ("" when it is not a clean path inside the site).
func lookup(target string) string {
	if i := strings.IndexAny(target, "?#"); i >= 0 {
		target = target[:i]
	}
	p, err := url.PathUnescape(target)
	if err != nil || !strings.HasPrefix(p, "/") || strings.ContainsRune(p, 0) || strings.Contains(p, "\\") {
		return ""
	}
	if c := path.Clean(p); c == p || (c == "/" && p == "/") {
		return c
	}
	return ""
}

const common = "X-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nX-Frame-Options: DENY\r\n"

var statusText = map[int]string{200: "OK", 304: "Not Modified", 400: "Bad Request", 404: "Not Found", 405: "Method Not Allowed", 414: "URI Too Long", 431: "Request Header Fields Too Large"}

func write(c net.Conn, status int, rq *request, extra string, body []byte, keep bool) {
	var b bytes.Buffer
	b.WriteString("HTTP/1.1 " + strconv.Itoa(status) + " " + statusText[status] + "\r\n" + common + extra)
	if status != 304 {
		b.WriteString("Content-Length: " + strconv.Itoa(len(body)) + "\r\n")
	}
	if keep {
		b.WriteString("Connection: keep-alive\r\n\r\n")
	} else {
		b.WriteString("Connection: close\r\n\r\n")
	}
	if status != 304 && !(rq != nil && rq.method == "HEAD") {
		b.Write(body)
	}
	c.SetWriteDeadline(time.Now().Add(readTimeout))
	c.Write(b.Bytes())
}

func handle(c net.Conn, rq *request) bool {
	keep := rq.keepAlive
	if rq.method != "GET" && rq.method != "HEAD" {
		write(c, 405, rq, "Allow: GET, HEAD\r\nContent-Type: text/plain\r\n", []byte("method not allowed\n"), false)
		return false
	}
	name := lookup(rq.target)
	if name == "/healthz" {
		write(c, 200, rq, "Content-Type: text/plain\r\nCache-Control: no-store\r\n", []byte("ok\n"), keep)
		return keep
	}
	a := assets[name]
	if a == nil {
		write(c, 404, rq, "Content-Type: text/plain\r\n", []byte("not found\n"), keep)
		return keep
	}
	head := "Content-Type: " + a.ctype + "\r\nETag: " + a.etag + "\r\nCache-Control: no-cache\r\nVary: Accept-Encoding\r\n"
	if strings.Contains(rq.ifNoneMatch, a.etag) {
		write(c, 304, rq, head, nil, keep)
		return keep
	}
	if rq.gzip {
		write(c, 200, rq, head+"Content-Encoding: gzip\r\n", a.gz, keep)
	} else {
		write(c, 200, rq, head, a.inflate(), keep)
	}
	return keep
}

func serve(c net.Conn) {
	defer c.Close()
	r := bufio.NewReaderSize(c, 4096)
	for {
		rq, status, err := readRequest(c, r)
		if err != nil {
			if status != 0 {
				write(c, status, nil, "Content-Type: text/plain\r\n", []byte(statusText[status]+"\n"), false)
			}
			return
		}
		if !handle(c, &rq) {
			return
		}
	}
}

func run(l net.Listener) {
	sem := make(chan struct{}, maxConns)
	for {
		c, err := l.Accept()
		if err != nil {
			return
		}
		sem <- struct{}{}
		go func() {
			defer func() { <-sem }()
			serve(c)
		}()
	}
}

func healthcheck(addr string) int {
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		return 1
	}
	c, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", port), 2*time.Second)
	if err != nil {
		return 1
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(2 * time.Second))
	c.Write([]byte("GET /healthz HTTP/1.0\r\n\r\n"))
	line, _ := bufio.NewReader(c).ReadString('\n')
	if strings.Contains(line, " 200 ") {
		return 0
	}
	return 1
}

func main() {
	def := ":8080"
	if p := os.Getenv("PORT"); p != "" {
		def = ":" + p
	}
	addr := flag.String("addr", def, "listen address")
	hc := flag.Bool("healthcheck", false, "probe the local server and exit")
	flag.Parse()
	if *hc {
		os.Exit(healthcheck(*addr))
	}
	load()
	l, err := net.Listen("tcp", *addr)
	if err != nil {
		os.Stderr.WriteString("dev-tools: " + err.Error() + "\n")
		os.Exit(1)
	}
	os.Stdout.WriteString("dev-tools listening on " + l.Addr().String() + "\n")
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT) // PID 1 ignores signals it has no handler for, so docker stop would otherwise wait for SIGKILL
	go func() { <-stop; l.Close() }()
	run(l)
}
