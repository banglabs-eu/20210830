/*
 * receipt-engine.js — turn receipt text into a CO2 damage cost.
 *
 * The maths is the same as the calculator on the front page:
 *     co2  = factor x quantity   (x 0.85 if eco-certified)
 *     cost = co2 / 1000 x carbon price per ton
 *
 * What this file adds is the bit a receipt needs and the calculator does not:
 * a line parser, a keyword table that maps supermarket wording (Danish and
 * English) onto those factors, and a default pack size for the very common
 * case where the receipt names a product but never says how much of it.
 *
 * Every assumption is returned as data, not hidden, so the UI can show it and
 * the user can correct it. A line we cannot match is never guessed at — it is
 * returned as unmatched and left out of the total.
 *
 * Loaded by receipt.html as a plain script (window.ReceiptEngine) and by
 * test/receipt-engine.test.js under node.
 */
(function (root) {
  'use strict';

  // --- Emission factors -----------------------------------------------------
  // kg CO2e per kg / litre / item, lifecycle. The first eleven food rows are
  // exactly the values the front-page calculator uses (CO2_DATA in index.html);
  // the rest are further rows from the same study, Poore & Nemecek (2018),
  // Science 360:987, global means per kg of retail product. Non-food rows are
  // the calculator's, unchanged.
  //
  // Nothing here is invented. If a product is not in the source it is simply
  // absent, and the receipt line for it comes back unmatched.
  var FACTORS = [
    // --- meat, fish, dairy, eggs -------------------------------------------
    { id: 'beef',      label: 'Beef',            unit: 'kg',    co2: 60,   pack: 0.5,  site: true,
      keywords: ['oksekød', 'okse', 'hakket okse', 'beef', 'steak', 'bøf', 'entrecote', 'ribeye', 'kalvekød'] },
    { id: 'lamb',      label: 'Lamb',            unit: 'kg',    co2: 24,   pack: 0.5,
      keywords: ['lammekød', 'lam', 'lamb', 'mutton'] },
    { id: 'pork',      label: 'Pork',            unit: 'kg',    co2: 7.2,  pack: 0.5,
      keywords: ['svinekød', 'svin', 'hakket svine', 'flæsk', 'bacon', 'pork', 'ham', 'skinke', 'pølse', 'pølser', 'sausage', 'nakkekam', 'kotelet'] },
    { id: 'chicken',   label: 'Chicken',         unit: 'kg',    co2: 6.9,  pack: 0.5,  site: true,
      keywords: ['kylling', 'chicken', 'poultry', 'fjerkræ', 'kalkun', 'turkey'] },
    { id: 'fish',      label: 'Fish (farmed)',   unit: 'kg',    co2: 13.6, pack: 0.4,
      keywords: ['laks', 'salmon', 'ørred', 'trout', 'fisk', 'fish', 'torsk', 'cod', 'tun', 'tuna'] },
    { id: 'prawns',    label: 'Prawns (farmed)', unit: 'kg',    co2: 26.9, pack: 0.2,
      keywords: ['rejer', 'prawn', 'prawns', 'shrimp', 'scampi'] },
    { id: 'cheese',    label: 'Cheese',          unit: 'kg',    co2: 21,   pack: 0.25, site: true,
      keywords: ['ost', 'cheese', 'mozzarella', 'parmesan', 'feta', 'cheddar', 'brie'] },
    { id: 'milk',      label: 'Milk (cow)',      unit: 'litre', co2: 3.15, pack: 1,    site: true,
      keywords: ['mælk', 'milk', 'minimælk', 'letmælk', 'sødmælk', 'skummetmælk', 'yoghurt', 'ymer', 'kefir', 'cream', 'fløde'] },
    { id: 'eggs',      label: 'Eggs',            unit: 'kg',    co2: 4.5,  pack: 0.6,  site: true,
      keywords: ['æg', 'eggs', 'egg'] },

    // --- staples, grains, sugar --------------------------------------------
    { id: 'rice',      label: 'Rice',            unit: 'kg',    co2: 4,    pack: 0.5,  site: true,
      keywords: ['ris', 'rice', 'basmati', 'jasminris'] },
    { id: 'bread',     label: 'Bread (wheat)',   unit: 'kg',    co2: 1.4,  pack: 0.7,  site: true,
      keywords: ['brød', 'bread', 'rugbrød', 'franskbrød', 'toast', 'boller', 'baguette', 'mel', 'flour', 'pasta', 'spaghetti', 'nudler', 'noodles', 'couscous'] },
    { id: 'oats',      label: 'Oats / barley',   unit: 'kg',    co2: 1.6,  pack: 1,
      keywords: ['havregryn', 'havre', 'oats', 'oatmeal', 'gryn', 'müsli', 'musli', 'granola'] },
    { id: 'maize',     label: 'Maize',           unit: 'kg',    co2: 1.1,  pack: 0.5,
      keywords: ['majs', 'maize', 'corn', 'popcorn'] },
    { id: 'potatoes',  label: 'Potatoes',        unit: 'kg',    co2: 0.46, pack: 1,    site: true,
      keywords: ['kartofler', 'kartoffel', 'potato', 'potatoes', 'pommes'] },
    { id: 'sugar',     label: 'Sugar (beet)',    unit: 'kg',    co2: 1.8,  pack: 1,
      keywords: ['sukker', 'sugar', 'rørsukker'] },

    // --- fruit and vegetables ----------------------------------------------
    { id: 'tomatoes',  label: 'Tomatoes',        unit: 'kg',    co2: 1.4,  pack: 0.5,  site: true,
      keywords: ['tomat', 'tomater', 'tomato', 'tomatoes', 'cherrytomat'] },
    { id: 'vegetables', label: 'Vegetables',     unit: 'kg',    co2: 0.5,  pack: 0.5,
      keywords: ['grøntsager', 'vegetables', 'agurk', 'cucumber', 'salat', 'lettuce', 'broccoli', 'blomkål', 'cauliflower', 'kål', 'cabbage', 'spinat', 'spinach', 'peberfrugt', 'pepper', 'squash', 'courgette', 'aubergine', 'champignon', 'mushroom', 'svampe'] },
    { id: 'roots',     label: 'Root vegetables', unit: 'kg',    co2: 0.43, pack: 0.5,
      keywords: ['gulerødder', 'gulerod', 'carrot', 'carrots', 'rodfrugter', 'løg', 'onion', 'porre', 'leek', 'hvidløg', 'garlic', 'rødbede', 'beetroot'] },
    { id: 'peas',      label: 'Peas / beans',    unit: 'kg',    co2: 0.9,  pack: 0.4,
      keywords: ['ærter', 'peas', 'bønner', 'beans', 'kikærter', 'chickpea', 'linser', 'lentils'] },
    { id: 'bananas',   label: 'Bananas',         unit: 'kg',    co2: 0.9,  pack: 1,
      keywords: ['banan', 'bananer', 'banana', 'bananas'] },
    { id: 'apples',    label: 'Apples',          unit: 'kg',    co2: 0.43, pack: 1,
      keywords: ['æbler', 'æble', 'apple', 'apples', 'pærer', 'pear'] },
    { id: 'citrus',    label: 'Citrus fruit',    unit: 'kg',    co2: 0.39, pack: 1,
      keywords: ['appelsin', 'orange', 'citron', 'lemon', 'lime', 'clementin', 'mandarin', 'grapefrugt'] },
    { id: 'berries',   label: 'Berries / grapes', unit: 'kg',   co2: 1.5,  pack: 0.3,
      keywords: ['jordbær', 'strawberry', 'strawberries', 'hindbær', 'raspberry', 'blåbær', 'blueberry', 'bær', 'berries', 'druer', 'grapes'] },
    { id: 'nuts',      label: 'Nuts',            unit: 'kg',    co2: 0.43, pack: 0.2,
      keywords: ['nødder', 'nuts', 'mandler', 'almond', 'valnødder', 'walnut', 'cashew', 'peanut', 'jordnødder'] },
    { id: 'tofu',      label: 'Tofu',            unit: 'kg',    co2: 3.2,  pack: 0.4,
      keywords: ['tofu', 'sojabønne'] },
    { id: 'soymilk',   label: 'Soy milk',        unit: 'litre', co2: 1,    pack: 1,
      keywords: ['sojamælk', 'soymilk', 'havremælk', 'oat milk', 'mandelmælk', 'plantedrik'] },

    // --- drinks, oils, treats ----------------------------------------------
    { id: 'coffee',    label: 'Coffee (roasted)', unit: 'kg',   co2: 17,   pack: 0.4,  site: true,
      keywords: ['kaffe', 'coffee', 'espresso'] },
    { id: 'chocolate', label: 'Dark chocolate',  unit: 'kg',    co2: 19,   pack: 0.1,  site: true,
      keywords: ['chokolade', 'chocolate', 'kakao', 'cocoa'] },
    { id: 'wine',      label: 'Wine',            unit: 'litre', co2: 1.4,  pack: 0.75,
      keywords: ['vin', 'wine', 'rødvin', 'hvidvin'] },
    { id: 'beer',      label: 'Beer',            unit: 'litre', co2: 1.1,  pack: 0.33,
      keywords: ['øl', 'beer', 'pilsner', 'lager', 'classic'] },
    { id: 'olive_oil', label: 'Olive oil',       unit: 'litre', co2: 6,    pack: 0.5,
      keywords: ['olivenolie', 'olive oil'] },
    { id: 'veg_oil',   label: 'Vegetable oil',   unit: 'litre', co2: 3.6,  pack: 0.5,
      keywords: ['solsikkeolie', 'rapsolie', 'madolie', 'sunflower oil', 'rapeseed oil', 'vegetable oil'] },

    // --- non-food (the calculator's own rows, for manual entry) -------------
    { id: 'cotton_tshirt',   label: 'Cotton T-shirt',   unit: 'item', co2: 7,    pack: 1, site: true, nonfood: true, keywords: ['t-shirt', 'tshirt'] },
    { id: 'cotton_jeans',    label: 'Jeans (denim)',    unit: 'item', co2: 33.4, pack: 1, site: true, nonfood: true, keywords: ['jeans', 'cowboybukser'] },
    { id: 'polyester_shirt', label: 'Polyester shirt',  unit: 'item', co2: 5.5,  pack: 1, site: true, nonfood: true, keywords: [] },
    { id: 'wool_sweater',    label: 'Wool sweater',     unit: 'item', co2: 27,   pack: 1, site: true, nonfood: true, keywords: ['sweater', 'trøje', 'uldtrøje'] },
    { id: 'leather_shoes',   label: 'Leather shoes',    unit: 'pair', co2: 15,   pack: 1, site: true, nonfood: true, keywords: ['sko', 'shoes', 'støvler'] },
    { id: 'smartphone',      label: 'Smartphone',       unit: 'item', co2: 70,   pack: 1, site: true, nonfood: true, keywords: ['mobiltelefon', 'smartphone', 'iphone'] },
    { id: 'laptop',          label: 'Laptop',           unit: 'item', co2: 300,  pack: 1, site: true, nonfood: true, keywords: ['laptop', 'bærbar'] },
    { id: 'petrol',          label: 'Petrol / Gasoline', unit: 'litre', co2: 2.31, pack: 40, site: true, nonfood: true, keywords: ['benzin', 'petrol', 'gasoline', 'blyfri', 'oktan'] },
    { id: 'diesel',          label: 'Diesel',           unit: 'litre', co2: 2.68, pack: 40, site: true, nonfood: true, keywords: ['diesel'] }
  ];

  // Lines that are receipt furniture, not products. Matched against the start
  // of the folded line.
  var NOISE = [
    'total', 'i alt', 'ialt', 'subtotal', 'sum', 'at betale', 'betalt', 'moms',
    'vat', 'kontant', 'dankort', 'visa', 'mastercard', 'kort', 'byttepenge',
    'change', 'retur', 'rabat', 'discount', 'coop', 'netto', 'fotex', 'bilka',
    'rema', 'lidl', 'aldi', 'meny', 'kvickly', 'superbrugsen', 'brugsen',
    'kvittering', 'receipt', 'bon', 'kasse', 'exp', 'cvr', 'tlf', 'tel',
    'butik', 'store', 'dato', 'date', 'tak for', 'thank you', 'medlem',
    'bonus', 'point', 'afrunding', 'pant', 'deposit', 'posenr', 'pose',
    'terminal', 'aut.kode', 'ref.nr', 'kortnr', 'godkendt', 'approved'
  ];

  var UNIT_TO_BASE = {
    kg: 1, kilo: 1, g: 0.001, gr: 0.001, gram: 0.001,
    l: 1, ltr: 1, liter: 1, litre: 1, ml: 0.001, cl: 0.01, dl: 0.1
  };

  // --- helpers --------------------------------------------------------------

  // Lowercase and strip the Danish letters so 'KØD' and 'kod' compare equal.
  // Keywords go through the same fold, so the table can stay written in real
  // Danish.
  function fold(s) {
    return String(s)
      .toLowerCase()
      .replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/å/g, 'aa')
      .replace(/ö/g, 'o').replace(/ä/g, 'ae').replace(/ü/g, 'u')
      .replace(/[^a-z0-9 .,/*x-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function num(s) {
    return parseFloat(String(s).replace(',', '.'));
  }

  // Keywords longest first, so 'oksekød' wins over 'okse' and 'havremælk'
  // (soymilk) wins over 'mælk'.
  var KEYWORD_INDEX = (function () {
    var index = [];
    for (var i = 0; i < FACTORS.length; i++) {
      var f = FACTORS[i];
      for (var k = 0; k < f.keywords.length; k++) {
        index.push({ key: fold(f.keywords[k]), factor: f });
      }
    }
    index.sort(function (a, b) { return b.key.length - a.key.length; });
    return index;
  })();

  function factorById(id) {
    for (var i = 0; i < FACTORS.length; i++) {
      if (FACTORS[i].id === id) return FACTORS[i];
    }
    return null;
  }

  function isNoise(folded) {
    for (var i = 0; i < NOISE.length; i++) {
      if (folded.indexOf(NOISE[i]) === 0) return true;
    }
    return false;
  }

  // --- line parsing ---------------------------------------------------------

  /*
   * Pull the shape of a receipt line apart:
   *   "2 x Hakket oksekød 500 g      79,90"
   *    ^count      ^name      ^qty    ^price
   * Any of the three numbers may be missing; only the name is required.
   */
  function parseLine(raw) {
    var line = String(raw).replace(/\s+/g, ' ').trim();
    if (line.length < 3) return null;
    if (!/[a-zA-ZæøåÆØÅ]/.test(line)) return null;

    var folded = fold(line);
    if (isNoise(folded)) return null;

    var price = null;
    var priceMatch = line.match(/(-?\d{1,4}[.,]\d{2})\s*(?:kr\.?|dkk|eur|€)?\s*$/i);
    if (priceMatch) {
      price = num(priceMatch[1]);
      line = line.slice(0, priceMatch.index).trim();
    }

    var count = 1;
    var countMatch = line.match(/^(\d{1,2})\s*[x*]\s*/i);
    if (countMatch) {
      count = parseInt(countMatch[1], 10);
      line = line.slice(countMatch[0].length).trim();
    }

    // An explicit weight or volume anywhere in what is left of the line.
    var qty = null;
    var qtyUnit = null;
    var qtyMatch = line.match(/(\d+(?:[.,]\d+)?)\s*(kg|kilo|gram|gr|g|ltr|liter|litre|ml|cl|dl|l)\b/i);
    if (qtyMatch) {
      var unitKey = qtyMatch[2].toLowerCase();
      if (UNIT_TO_BASE[unitKey]) {
        qty = num(qtyMatch[1]) * UNIT_TO_BASE[unitKey];
        qtyUnit = (unitKey === 'l' || unitKey === 'ltr' || unitKey === 'liter' ||
                   unitKey === 'litre' || unitKey === 'ml' || unitKey === 'cl' ||
                   unitKey === 'dl') ? 'litre' : 'kg';
        line = (line.slice(0, qtyMatch.index) + ' ' + line.slice(qtyMatch.index + qtyMatch[0].length)).trim();
      }
    }

    // A bare 'stk' count, e.g. '3 stk'.
    var stkMatch = line.match(/(\d{1,2})\s*(stk|pcs|pk)\b/i);
    if (stkMatch && count === 1) {
      count = parseInt(stkMatch[1], 10);
      line = (line.slice(0, stkMatch.index) + ' ' + line.slice(stkMatch.index + stkMatch[0].length)).trim();
    }

    // Leading article numbers are barcodes and PLU codes, not quantities.
    line = line.replace(/^\d{4,}\s*/, '').replace(/\s{2,}/g, ' ').trim();

    var name = line.replace(/[.\-*]+$/, '').trim();
    if (!name || !/[a-zA-ZæøåÆØÅ]/.test(name)) return null;

    return { raw: String(raw).trim(), name: name, count: count, qty: qty, qtyUnit: qtyUnit, price: price };
  }

  /* The longest keyword contained in the product name wins; null if none do. */
  function matchFactor(name) {
    var folded = fold(name);
    for (var i = 0; i < KEYWORD_INDEX.length; i++) {
      var entry = KEYWORD_INDEX[i];
      if (folded.indexOf(entry.key) !== -1) return entry.factor;
    }
    return null;
  }

  /*
   * One parsed line + one factor -> an item with a quantity we can multiply.
   * `assumed` is true when the receipt never said how much, so the pack size
   * from the table was used instead; the UI leans on this to tell the user
   * which numbers are a guess.
   */
  function buildItem(parsed, factor) {
    var assumed = false;
    var quantity;

    if (parsed.qty !== null && factor.unit !== 'item' && factor.unit !== 'pair') {
      quantity = parsed.qty * parsed.count;
    } else {
      quantity = factor.pack * parsed.count;
      assumed = parsed.qty === null;
    }

    return {
      name: parsed.name,
      raw: parsed.raw,
      factorId: factor.id,
      label: factor.label,
      unit: factor.unit,
      co2PerUnit: factor.co2,
      quantity: quantity,
      assumed: assumed,
      price: parsed.price,
      include: true
    };
  }

  /* Read a whole OCR blob into items we recognised and lines we did not. */
  function parseReceipt(text) {
    var lines = String(text).split(/\r?\n/);
    var items = [];
    var unmatched = [];

    for (var i = 0; i < lines.length; i++) {
      var parsed = parseLine(lines[i]);
      if (!parsed) continue;
      var factor = matchFactor(parsed.name);
      if (factor) {
        items.push(buildItem(parsed, factor));
      } else {
        unmatched.push(parsed);
      }
    }

    return { items: items, unmatched: unmatched };
  }

  // --- the calculation ------------------------------------------------------

  /*
   * Identical to the front page: kg CO2e x carbon price per ton, with the same
   * 15% eco discount. Items the user switched off are skipped but kept, so the
   * totals move without losing the row.
   */
  function total(items, carbonPricePerTon, eco) {
    var co2 = 0;
    var spend = 0;
    var counted = 0;

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.include === false) continue;
      co2 += it.co2PerUnit * it.quantity;
      if (typeof it.price === 'number' && !isNaN(it.price)) spend += it.price;
      counted++;
    }

    if (eco) co2 *= 0.85;
    var cost = (co2 / 1000) * carbonPricePerTon;

    return { co2: co2, cost: cost, spend: spend, count: counted };
  }

  root.ReceiptEngine = {
    FACTORS: FACTORS,
    fold: fold,
    parseLine: parseLine,
    matchFactor: matchFactor,
    buildItem: buildItem,
    parseReceipt: parseReceipt,
    total: total,
    factorById: factorById
  };
})(typeof module !== 'undefined' && module.exports ? module.exports : window);
