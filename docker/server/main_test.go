package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

var addr string

func TestMain(m *testing.M) {
	load()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		panic(err)
	}
	addr = l.Addr().String()
	go run(l)
	m.Run()
}

type response struct {
	status  string
	headers map[string]string
	body    []byte
}

// roundTrip sends raw bytes on a fresh connection and reads one response (nil when the server just closed).
func roundTrip(t *testing.T, raw string) *response {
	t.Helper()
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.Write([]byte(raw))
	return readResponse(t, bufio.NewReader(c), strings.HasPrefix(raw, "HEAD"))
}

func readResponse(t *testing.T, r *bufio.Reader, head bool) *response {
	t.Helper()
	line, err := r.ReadString('\n')
	if err != nil {
		return nil
	}
	resp := &response{status: strings.TrimSpace(line), headers: map[string]string{}}
	for {
		h, err := r.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		h = strings.TrimRight(h, "\r\n")
		if h == "" {
			break
		}
		k, v, _ := strings.Cut(h, ":")
		resp.headers[strings.ToLower(k)] = strings.TrimSpace(v)
	}
	if n := resp.headers["content-length"]; n != "" && !head {
		size := 0
		for _, ch := range n {
			size = size*10 + int(ch-'0')
		}
		resp.body = make([]byte, size)
		if _, err := io.ReadFull(r, resp.body); err != nil {
			t.Fatal(err)
		}
	}
	return resp
}

func get(t *testing.T, target, extra string) *response {
	return roundTrip(t, "GET "+target+" HTTP/1.1\r\nHost: x\r\n"+extra+"Connection: close\r\n\r\n")
}

func TestServesGzippedAndPlain(t *testing.T) {
	z := get(t, "/toolbox.html", "Accept-Encoding: gzip, deflate\r\n")
	if z.status != "HTTP/1.1 200 OK" || z.headers["content-encoding"] != "gzip" || !strings.HasPrefix(z.headers["content-type"], "text/html") {
		t.Fatalf("gzip response: %+v", z.headers)
	}
	zr, err := gzip.NewReader(bytes.NewReader(z.body))
	if err != nil {
		t.Fatal(err)
	}
	want, _ := io.ReadAll(zr)
	p := get(t, "/toolbox.html", "")
	if p.headers["content-encoding"] != "" || !bytes.Equal(p.body, want) || !bytes.Contains(p.body, []byte("<html")) {
		t.Fatalf("plain response differs from the inflated gzip one (%d vs %d bytes)", len(p.body), len(want))
	}
	if q := get(t, "/toolbox.html", "Accept-Encoding: gzip;q=0\r\n"); q.headers["content-encoding"] != "" {
		t.Fatal("gzip;q=0 must not get gzip")
	}
}

func TestRootIndexTypesAndHeaders(t *testing.T) {
	r := get(t, "/", "Accept-Encoding: gzip\r\n")
	if r.status != "HTTP/1.1 200 OK" || r.headers["x-content-type-options"] != "nosniff" || r.headers["etag"] == "" || r.headers["cache-control"] != "no-cache" || r.headers["vary"] != "Accept-Encoding" {
		t.Fatalf("%+v", r.headers)
	}
	if q := get(t, "/?x=1#frag", "Accept-Encoding: gzip\r\n"); q.status != "HTTP/1.1 200 OK" {
		t.Fatal("query strings are ignored")
	}
	if c := get(t, "/catalog.js", "Accept-Encoding: gzip\r\n"); !strings.HasPrefix(c.headers["content-type"], "text/javascript") {
		t.Fatalf("js type: %v", c.headers["content-type"])
	}
}

func TestConditionalAndHead(t *testing.T) {
	etag := get(t, "/", "").headers["etag"]
	n := get(t, "/", "If-None-Match: "+etag+"\r\n")
	if n.status != "HTTP/1.1 304 Not Modified" || len(n.body) != 0 {
		t.Fatalf("304: %+v", n)
	}
	h := roundTrip(t, "HEAD / HTTP/1.1\r\nHost: x\r\nAccept-Encoding: gzip\r\nConnection: close\r\n\r\n")
	if h.status != "HTTP/1.1 200 OK" || h.headers["content-length"] == "" || len(h.body) != 0 {
		t.Fatalf("HEAD: %+v", h)
	}
}

func TestNotFoundAndTraversal(t *testing.T) {
	for _, target := range []string{"/nope.html", "/../etc/passwd", "/%2e%2e/etc/passwd", "/assets/../index.html", "/assets//theme.css", "/sheets/", "/a\\b", "/%00", "/%zz", "noslash", "/index.html.gz", "/toolbox.html.gz"} {
		if r := get(t, target, ""); r == nil || !(strings.Contains(r.status, "404") || strings.Contains(r.status, "400")) {
			t.Errorf("%q should not be served: %v", target, r)
		}
	}
}

func TestMethodsAndMalformed(t *testing.T) {
	if r := roundTrip(t, "POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n"); r == nil || !strings.Contains(r.status, "405") || r.headers["allow"] == "" {
		t.Fatalf("POST: %v", r)
	}
	for _, raw := range []string{"garbage\r\n\r\n", "GET / HTTP/2.0\r\n\r\n", "GET / HTTP/1.1\r\nbroken header\r\n\r\n", "GET / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n", "GET / HTTP/1.1\r\nContent-Length: 5\r\n\r\nhello"} {
		if r := roundTrip(t, raw); r == nil || !strings.Contains(r.status, "400") {
			t.Errorf("%q should be a 400, got %v", raw, r)
		}
	}
	if r := roundTrip(t, "GET /"+strings.Repeat("a", 5000)+" HTTP/1.1\r\n\r\n"); r == nil || !strings.Contains(r.status, "414") {
		t.Errorf("long target: %v", r)
	}
	if r := roundTrip(t, "GET / HTTP/1.1\r\nX: "+strings.Repeat("a", 3000)+"\r\nY: "+strings.Repeat("b", 3000)+"\r\nZ: "+strings.Repeat("c", 3000)+"\r\n\r\n"); r == nil || !strings.Contains(r.status, "431") {
		t.Errorf("large headers: %v", r)
	}
}

func TestKeepAliveAndHealth(t *testing.T) {
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	r := bufio.NewReader(c)
	for i := 0; i < 3; i++ {
		c.Write([]byte("GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n"))
		resp := readResponse(t, r, false)
		if resp == nil || resp.status != "HTTP/1.1 200 OK" || string(resp.body) != "ok\n" || resp.headers["connection"] != "keep-alive" {
			t.Fatalf("request %d on the same connection: %+v", i, resp)
		}
	}
	c.Write([]byte("GET /healthz HTTP/1.1\r\nConnection: close\r\n\r\n"))
	if resp := readResponse(t, r, false); resp == nil || resp.headers["connection"] != "close" {
		t.Fatal("Connection: close must be honoured")
	}
	c.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := r.ReadByte(); err == nil {
		t.Fatal("the server should have closed the connection")
	}
	if r10 := roundTrip(t, "GET /healthz HTTP/1.0\r\n\r\n"); r10 == nil || r10.headers["connection"] != "close" {
		t.Fatal("HTTP/1.0 closes after the response")
	}
	if code := healthcheck(addr); code != 0 {
		t.Fatalf("healthcheck exit code %d", code)
	}
	if code := healthcheck("127.0.0.1:1"); code == 0 {
		t.Fatal("healthcheck must fail when nothing listens")
	}
}

func TestEveryEmbeddedFileInflates(t *testing.T) {
	if len(assets) < 40 {
		t.Fatalf("only %d assets embedded", len(assets))
	}
	for name, a := range assets {
		if len(a.inflate()) == 0 {
			t.Errorf("%s inflates to nothing", name)
		}
	}
}
