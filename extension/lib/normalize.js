/*
 * lib/normalize.js — pure address-normalization helpers.
 * No chrome.* references. Loads as:
 *   - a classic script in the MV3 service worker (importScripts) and content
 *     script (manifest js list), exposing globalThis.TaxExtNormalize
 *   - a CommonJS module under plain `node` for tests (module.exports)
 */
(function (root, factory) {
  var mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (root) root.TaxExtNormalize = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var STATE_MAP = {
    ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA',
    COLORADO: 'CO', CONNECTICUT: 'CT', DELAWARE: 'DE', FLORIDA: 'FL', GEORGIA: 'GA',
    HAWAII: 'HI', IDAHO: 'ID', ILLINOIS: 'IL', INDIANA: 'IN', IOWA: 'IA',
    KANSAS: 'KS', KENTUCKY: 'KY', LOUISIANA: 'LA', MAINE: 'ME', MARYLAND: 'MD',
    MASSACHUSETTS: 'MA', MICHIGAN: 'MI', MINNESOTA: 'MN', MISSISSIPPI: 'MS',
    MISSOURI: 'MO', MONTANA: 'MT', NEBRASKA: 'NE', NEVADA: 'NV',
    'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ', 'NEW MEXICO': 'NM', 'NEW YORK': 'NY',
    'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND', OHIO: 'OH', OKLAHOMA: 'OK',
    OREGON: 'OR', PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI', 'SOUTH CAROLINA': 'SC',
    'SOUTH DAKOTA': 'SD', TENNESSEE: 'TN', TEXAS: 'TX', UTAH: 'UT', VERMONT: 'VT',
    VIRGINIA: 'VA', WASHINGTON: 'WA', 'WEST VIRGINIA': 'WV', WISCONSIN: 'WI',
    WYOMING: 'WY', 'DISTRICT OF COLUMBIA': 'DC'
  };
  var STATE_ABBRS = {};
  Object.keys(STATE_MAP).forEach(function (k) { STATE_ABBRS[STATE_MAP[k]] = true; });

  // Street-suffix normalization: every variant maps to one canonical short form.
  var SUFFIX_MAP = {
    STREET: 'ST', STR: 'ST', ST: 'ST',
    AVENUE: 'AVE', AVEN: 'AVE', AVENU: 'AVE', AV: 'AVE', AVE: 'AVE',
    ROAD: 'RD', RD: 'RD',
    DRIVE: 'DR', DRV: 'DR', DR: 'DR',
    LANE: 'LN', LN: 'LN',
    COURT: 'CT', CRT: 'CT', CT: 'CT',
    PLACE: 'PL', PL: 'PL',
    BOULEVARD: 'BLVD', BOULV: 'BLVD', BLVD: 'BLVD',
    PARKWAY: 'PKWY', PKWY: 'PKWY', PKY: 'PKWY', PARKWY: 'PKWY',
    WAY: 'WAY', WY: 'WAY',
    CIRCLE: 'CIR', CIRC: 'CIR', CIR: 'CIR',
    TRAIL: 'TRL', TRL: 'TRL',
    TERRACE: 'TER', TERR: 'TER', TER: 'TER',
    HIGHWAY: 'HWY', HWY: 'HWY',
    SQUARE: 'SQ', SQ: 'SQ',
    POINT: 'PT', PT: 'PT',
    PIKE: 'PIKE',
    LOOP: 'LOOP', RUN: 'RUN', ROW: 'ROW', BEND: 'BEND', PATH: 'PATH', PASS: 'PASS',
    CROSSING: 'XING', XING: 'XING',
    EXTENSION: 'EXT', EXT: 'EXT',
    ALLEY: 'ALY', ALY: 'ALY'
  };

  var DIR_MAP = {
    NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W',
    NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW',
    N: 'N', S: 'S', E: 'E', W: 'W', NE: 'NE', NW: 'NW', SE: 'SE', SW: 'SW'
  };

  // Unit designators: everything from one of these tokens onward is dropped.
  var UNIT_TOKENS = { APT: 1, APARTMENT: 1, UNIT: 1, STE: 1, SUITE: 1, LOT: 1, BLDG: 1, BUILDING: 1, FL: 1, FLOOR: 1, RM: 1, ROOM: 1, TRLR: 1, '#': 1 };

  /** '  ohio ' -> 'OH'; 'oh' -> 'OH'; 'XX' -> 'XX' (valid 2-letter kept); junk -> '' */
  function normalizeState(s) {
    if (!s) return '';
    var t = String(s).trim().toUpperCase().replace(/\./g, '');
    if (t.length === 2 && STATE_ABBRS[t]) return t;
    if (STATE_MAP[t]) return STATE_MAP[t];
    // e.g. "OH - Ohio" select-option text
    var m = t.match(/^([A-Z]{2})\b/);
    if (m && STATE_ABBRS[m[1]]) return m[1];
    for (var name in STATE_MAP) { if (t.indexOf(name) !== -1) return STATE_MAP[name]; }
    return '';
  }

  /** '45040-1234' -> {zip5:'45040', plus4:'1234'}; '45040' -> {zip5:'45040', plus4:null} */
  function parseZip(z) {
    if (!z) return null;
    var m = String(z).match(/(\d{5})(?:[-\s]?(\d{4}))?/);
    if (!m) return null;
    return { zip5: m[1], plus4: m[2] || null };
  }

  /**
   * Canonicalize a street NAME (no house number): uppercase, strip punctuation,
   * drop unit designators, normalize directionals and the trailing suffix.
   * 'Abbeycross Lane' -> 'ABBEYCROSS LN'; 'N. Main Street Apt 4' -> 'N MAIN ST'
   */
  function normalizeStreetName(name) {
    if (!name) return '';
    var s = String(name).toUpperCase()
      .replace(/[.,']/g, ' ')
      .replace(/#\s*\S*/g, ' # ')      // '#5' -> unit marker token
      .replace(/\s+/g, ' ')
      .trim();
    if (!s) return '';
    var tokens = s.split(' ');
    // Cut at the first unit designator (but never cut the very first token).
    for (var i = 1; i < tokens.length; i++) {
      if (UNIT_TOKENS[tokens[i]]) { tokens = tokens.slice(0, i); break; }
    }
    // Directionals anywhere.
    tokens = tokens.map(function (t) { return DIR_MAP[t] || t; });
    // Suffix: only the last token (avoids 'ST' in 'ST RT 42' mid-string issues).
    if (tokens.length > 1) {
      var last = tokens[tokens.length - 1];
      // trailing directional after suffix: 'MAIN ST W' — normalize both.
      if (DIR_MAP[last] && tokens.length > 2) {
        var beforeLast = tokens[tokens.length - 2];
        if (SUFFIX_MAP[beforeLast]) tokens[tokens.length - 2] = SUFFIX_MAP[beforeLast];
      } else if (SUFFIX_MAP[last]) {
        tokens[tokens.length - 1] = SUFFIX_MAP[last];
      }
    }
    return tokens.join(' ');
  }

  /**
   * Parse a full street line into house number + canonical street name.
   * '15 Abbeycross Lane' -> {number:15, name:'ABBEYCROSS LN'}
   * 'PO Box 5' / 'Jane Doe' -> null
   */
  function parseStreet(street) {
    if (!street) return null;
    var m = String(street).trim().match(/^(\d+)[A-Za-z]?(?:[-\/]\d*[A-Za-z]?)?\s+(.+)$/);
    if (!m) return null;
    var name = normalizeStreetName(m[2]);
    if (!name) return null;
    return { number: parseInt(m[1], 10), name: name };
  }

  /**
   * Stable dedup/cache key for an address. Normalizes state (OH == Ohio),
   * street suffixes (St == Street) and ZIP to 5 digits.
   */
  function addressKey(street, city, state, zip) {
    var st = normalizeState(state) || String(state || '').trim().toUpperCase();
    var z = parseZip(zip);
    var zs = z ? z.zip5 + (z.plus4 ? '-' + z.plus4 : '') : String(zip || '').trim();
    var p = parseStreet(street);
    var streetNorm = p ? p.number + ' ' + p.name : normalizeStreetName(street);
    return [st, zs, String(city || '').trim().toUpperCase(), streetNorm].join('|');
  }

  /** 0.0675 -> '6.75' */
  function pctString(rate) {
    return (Math.round(rate * 10000) / 100).toFixed(2);
  }

  return {
    STATE_MAP: STATE_MAP,
    normalizeState: normalizeState,
    parseZip: parseZip,
    normalizeStreetName: normalizeStreetName,
    parseStreet: parseStreet,
    addressKey: addressKey,
    pctString: pctString
  };
});
