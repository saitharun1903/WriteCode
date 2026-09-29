// Tells Bing (and Edge, DuckDuckGo, Yahoo, Yandex, Seznam) that pages changed, so
// they are crawled within hours instead of weeks. Run after a deploy:
//   node deploy/indexnow.mjs
// The key is public by design: it only proves that the list comes from this site
// (the same key is served at https://writecode.in/<key>.txt).
const HOST = "writecode.in";
const KEY = "ac49bc22a0b14743d6b7a419c53cec14";

const sitemap = await (await fetch(`https://${HOST}/sitemap.xml`)).text();
const urlList = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
const res = await fetch("https://api.indexnow.org/indexnow", {
  method: "POST",
  headers: { "content-type": "application/json; charset=utf-8" },
  body: JSON.stringify({ host: HOST, key: KEY, keyLocation: `https://${HOST}/${KEY}.txt`, urlList }),
});
console.log(`IndexNow: ${res.status} ${res.statusText} for ${urlList.length} URLs`);
if (res.status >= 400) process.exit(1);
