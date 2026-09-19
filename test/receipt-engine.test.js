/*
 * node --test test/
 *
 * The parser is the risky part of the receipt app: OCR text is messy, and a
 * wrong quantity is worse than no quantity because it produces a confident
 * number. These cases pin down the shapes a Danish supermarket receipt
 * actually comes in.
 */
var test = require('node:test');
var assert = require('node:assert');
var E = require('../receipt-engine.js').ReceiptEngine;

test('fold makes Danish and ASCII spellings compare equal', function () {
  assert.strictEqual(E.fold('HAKKET OKSEKØD'), 'hakket oksekod');
  assert.strictEqual(E.fold('Æbler'), 'aebler');
  assert.strictEqual(E.fold('Mælk  1 L'), 'maelk 1 l');
});

test('a price at the end of the line is read and removed from the name', function () {
  var p = E.parseLine('Rugbrød grovt              22,95');
  assert.strictEqual(p.price, 22.95);
  assert.strictEqual(p.name, 'Rugbrød grovt');
  assert.strictEqual(p.count, 1);
});

test('an explicit weight beats the assumed pack size', function () {
  var p = E.parseLine('Hakket oksekød 8-12% 0,450 kg   44,50');
  assert.strictEqual(p.qty, 0.45);
  assert.strictEqual(p.qtyUnit, 'kg');

  var item = E.buildItem(p, E.matchFactor(p.name));
  assert.strictEqual(item.factorId, 'beef');
  assert.strictEqual(item.quantity, 0.45);
  assert.strictEqual(item.assumed, false);
});

test('grams and millilitres convert to the base unit', function () {
  assert.strictEqual(E.parseLine('Ost revet 250 g 24,00').qty, 0.25);
  assert.strictEqual(E.parseLine('Fløde 500 ml 18,00').qty, 0.5);
  assert.strictEqual(E.parseLine('Sodavand 33 cl 9,00').qty, 0.33);
});

test('a line with no quantity falls back to the pack size and says so', function () {
  var p = E.parseLine('Kyllingebryst            52,00');
  var item = E.buildItem(p, E.matchFactor(p.name));
  assert.strictEqual(item.factorId, 'chicken');
  assert.strictEqual(item.quantity, 0.5);
  assert.strictEqual(item.assumed, true);
});

test('a leading multiplier multiplies the quantity', function () {
  var p = E.parseLine('2 x Mælk 1 L               25,00');
  assert.strictEqual(p.count, 2);
  var item = E.buildItem(p, E.matchFactor(p.name));
  assert.strictEqual(item.factorId, 'milk');
  assert.strictEqual(item.quantity, 2);
  assert.strictEqual(item.assumed, false);
});

test('the longest keyword wins over a substring of it', function () {
  assert.strictEqual(E.matchFactor('Hakket oksekød').id, 'beef');
  assert.strictEqual(E.matchFactor('Havremælk barista').id, 'soymilk');
  assert.strictEqual(E.matchFactor('Letmælk 0,5%').id, 'milk');
  assert.strictEqual(E.matchFactor('Olivenolie ekstra jomfru').id, 'olive_oil');
});

test('receipt furniture is dropped, not parsed as a product', function () {
  assert.strictEqual(E.parseLine('TOTAL                 348,50'), null);
  assert.strictEqual(E.parseLine('MOMS 25%               69,70'), null);
  assert.strictEqual(E.parseLine('Dankort                348,50'), null);
  assert.strictEqual(E.parseLine('Tak for besøget'), null);
  assert.strictEqual(E.parseLine('   '), null);
  assert.strictEqual(E.parseLine('2026-09-19 14:32'), null);
});

test('an unknown product is reported, never guessed at', function () {
  var out = E.parseReceipt('Smør Lurpak 200 g   28,95');
  assert.strictEqual(out.items.length, 0);
  assert.strictEqual(out.unmatched.length, 1);
  assert.strictEqual(out.unmatched[0].name.indexOf('Smør'), 0);
});

test('a whole receipt splits into matched items and leftovers', function () {
  var receipt = [
    'SUPERBRUGSEN VANLØSE',
    'Kvittering 19-09-2026 14:32',
    '',
    'Hakket oksekød 0,400 kg      42,00',
    'Letmælk 1 L                  12,50',
    'Rugbrød                      24,95',
    'Bananer 1,10 kg              13,20',
    'Smør Lurpak                  28,95',
    '2 x Kaffe 400 g              89,90',
    '',
    'I ALT                       211,50',
    'Dankort                     211,50'
  ].join('\n');

  var out = E.parseReceipt(receipt);
  var ids = out.items.map(function (i) { return i.factorId; });
  assert.deepStrictEqual(ids, ['beef', 'milk', 'bread', 'bananas', 'coffee']);
  assert.strictEqual(out.unmatched.length, 1, 'butter has no factor in the source');

  var coffee = out.items[4];
  assert.strictEqual(coffee.quantity, 0.8, '2 x 400 g');
});

test('the total is the front-page formula: kg CO2e / 1000 x price per ton', function () {
  var items = [
    { factorId: 'beef', co2PerUnit: 60, quantity: 0.5, price: 42, include: true },
    { factorId: 'milk', co2PerUnit: 3.15, quantity: 1, price: 12.5, include: true }
  ];

  var t = E.total(items, 100, false);
  assert.strictEqual(+t.co2.toFixed(2), 33.15);
  assert.strictEqual(+t.cost.toFixed(4), 3.315);
  assert.strictEqual(t.spend, 54.5);
  assert.strictEqual(t.count, 2);
});

test('eco-certified takes 15% off, exactly as the calculator does', function () {
  var items = [{ co2PerUnit: 60, quantity: 1, price: 80, include: true }];
  assert.strictEqual(E.total(items, 100, true).co2, 51);
  assert.strictEqual(+E.total(items, 100, true).cost.toFixed(3), 5.1);
});

test('an excluded item leaves the total but stays in the list', function () {
  var items = [
    { co2PerUnit: 60, quantity: 1, price: 80, include: true },
    { co2PerUnit: 3.15, quantity: 1, price: 12, include: false }
  ];
  var t = E.total(items, 100, false);
  assert.strictEqual(t.co2, 60);
  assert.strictEqual(t.spend, 80);
  assert.strictEqual(t.count, 1);
  assert.strictEqual(items.length, 2);
});

test('the site factors are carried over unchanged', function () {
  // If someone edits CO2_DATA in index.html, these must move with it.
  var expected = {
    beef: 60, chicken: 6.9, cheese: 21, milk: 3.15, rice: 4, coffee: 17,
    chocolate: 19, tomatoes: 1.4, potatoes: 0.46, eggs: 4.5, bread: 1.4,
    petrol: 2.31, diesel: 2.68, smartphone: 70, laptop: 300
  };
  Object.keys(expected).forEach(function (id) {
    assert.strictEqual(E.factorById(id).co2, expected[id], id + ' drifted from the site value');
  });
});
