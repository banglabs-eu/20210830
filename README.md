# Prices that reflect Cost

Static website. Open `index.html` in a browser or serve locally:

```bash
python3 -m http.server 8080
```

Then visit http://localhost:8080

## Pages

- `index.html` — the site. The front-page calculator's emission factors live in
  `CO2_DATA`, near the bottom of the file.
- `receipt.html` — photograph a shop receipt and get the CO₂ damage cost for the
  whole basket. OCR (Tesseract.js, loaded from a CDN on first use) and the
  arithmetic both run in the visitor's browser; no image is uploaded and there
  is no backend.

## receipt-engine.js

Parsing, keyword matching and the cost calculation for `receipt.html`, kept in
its own file so it can be tested outside a browser. It holds its own factor
table: the front page's eleven food rows unchanged, plus further rows from the
same source (Poore & Nemecek 2018). **The two tables have to be edited
together** — `test/receipt-engine.test.js` fails if the shared values drift.

```bash
node --test test/receipt-engine.test.js
```

No dependencies and no build step; the tests need only Node.
