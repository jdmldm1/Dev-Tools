(function () {
  const lib = DT.lib;
  const cap = w => w.charAt(0).toUpperCase() + w.slice(1);

  lib.caseStyles = [
    { id: "camel", name: "camelCase", fn: s => lib.camel(s) },
    { id: "pascal", name: "PascalCase", fn: s => lib.pascal(s) },
    { id: "snake", name: "snake_case", fn: s => lib.snake(s) },
    { id: "constant", name: "CONSTANT_CASE", fn: s => lib.words(s).map(w => w.toUpperCase()).join("_") },
    { id: "kebab", name: "kebab-case", fn: s => lib.kebab(s) },
    { id: "train", name: "Train-Case", fn: s => lib.words(s).map(w => cap(w.toLowerCase())).join("-") },
    { id: "dot", name: "dot.case", fn: s => lib.words(s).map(w => w.toLowerCase()).join(".") },
    { id: "path", name: "path/case", fn: s => lib.words(s).map(w => w.toLowerCase()).join("/") },
    { id: "title", name: "Title Case", fn: s => s.toLowerCase().replace(/(^|[\s\-/(])(\p{L})/gu, (m, p, c) => p + c.toUpperCase()) },
    { id: "sentence", name: "Sentence case", fn: s => s.toLowerCase().replace(/(^\s*|[.!?]\s+)(\p{L})/gu, (m, p, c) => p + c.toUpperCase()) },
    { id: "lower", name: "lower case", fn: s => s.toLowerCase() },
    { id: "upper", name: "UPPER CASE", fn: s => s.toUpperCase() },
    { id: "swap", name: "sWAP cASE", fn: s => [...s].map(c => c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()).join("") },
  ];
  lib.convertCase = (id, text) => text.split("\n").map(l => lib.caseStyles.find(s => s.id === id).fn(l)).join("\n");

  DT.register({
    id: "case", name: "Case Converter", group: "Text",
    desc: "Convert identifiers and text between camelCase, PascalCase, snake_case, kebab-case, CONSTANT_CASE, Title Case and more. Each line is converted separately.",
    keywords: "camel pascal snake kebab constant title sentence uppercase lowercase naming convention rename",
    render(root) {
      root.innerHTML = `
        <div class="col"><label class="l" for="in">Input (one identifier or phrase per line)</label><textarea id="in" class="sm" spellcheck="false">parseHTTPResponse
user_account-id
Hello wide World</textarea></div>
        <div class="panel"><div id="res"></div></div>`;
      const $ = s => root.querySelector(s);
      function run() {
        const t = $("#in").value;
        $("#res").innerHTML = `<table class="kv"><tbody>${lib.caseStyles.map(s => {
          const out = lib.convertCase(s.id, t);
          return `<tr><td class="k">${DT.esc(s.name)}</td><td class="v" style="white-space:pre-wrap">${DT.esc(out)}</td><td class="cp"><button class="mini" type="button" data-copytext="${DT.esc(out)}">copy</button></td></tr>`;
        }).join("")}</tbody></table>`;
      }
      $("#in").addEventListener("input", DT.debounce(run, 100)); run();
    },
  });
})();
