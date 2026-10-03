/** A tiny bill-splitting web app for end-to-end tests. `broken` makes its API answer with an HTML page. */
export function splitApp(broken: boolean): Record<string, string> {
  const page = `<!doctype html><html><head><title>Split</title></head><body>
<h1>Split the bill</h1>
<label>Amount <input id="amount" inputmode="decimal"></label>
<label for="people">People</label><input id="people" value="3">
<select aria-label="Currency"><option value="usd">Dollars</option><option value="eur">Euros</option></select>
<button id="go">Split</button>
<p id="out"></p><div id="err" role="alert"></div>
<script>
document.getElementById("go").addEventListener("click", async () => {
  const amount = Number(document.getElementById("amount").value);
  document.getElementById("err").textContent = "";
  if (!(amount > 0)) { document.getElementById("err").textContent = "Amount must be greater than 0"; return; }
  try {
    const response = await fetch("/api/split?amount=" + amount + "&people=" + document.getElementById("people").value);
    const data = await response.json();
    document.getElementById("out").textContent = "Each pays " + data.each;
  } catch (error) {
    document.getElementById("err").textContent = "Unexpected response from the server";
  }
});
</script></body></html>`;
  const server = `const http = require("http");
const page = ${JSON.stringify(page)};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/split" && ${!broken}) {
    const each = (Number(url.searchParams.get("amount")) / Number(url.searchParams.get("people"))).toFixed(2);
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ each }));
  }
  res.setHeader("content-type", "text/html");
  res.end(page);
});
server.listen(0, "127.0.0.1", () => console.log("Ready on http://localhost:" + server.address().port + "/"));
`;
  return {
    "package.json": JSON.stringify({ name: "split", private: true, scripts: { dev: "node server.js" } }),
    "server.js": server,
    "node_modules/.keep": "",
  };
}

export const SPLIT_CASES = {
  cases: [
    { name: "Splits a bill equally", steps: [{ fill: "Amount", value: "90" }, { select: "Currency", value: "Euros" }, { click: "Split" }, { expect: "Each pays 30.00" }, { screenshot: "Split result" }] },
    { name: "Rejects an empty amount", allowErrors: true, steps: [{ click: "Split" }, { expect: "Amount must be greater than 0" }] },
  ],
};
