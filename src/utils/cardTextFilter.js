/**
 * The SQL for "show me cards that do this" — a free-text search of the rules
 * text, plus named abilities (Draw, Discard, Mill, ...) for the actions that
 * are worded too many ways to type.
 *
 * Free text: every word has to appear somewhere in `oracle_text`, so
 * `draw card` finds "draw a card" and "draws two cards"; a quoted phrase has
 * to appear as written, so `"target player draws"` means exactly that.
 *
 * Abilities: each is a list of phrasings the action actually appears in, with
 * no SQLite REGEXP to lean on. They approximate, like ROLE_FILTERS in
 * cardRoleService.js — good enough to put the right cards in front of someone,
 * not a rules engine. Several abilities must all match.
 *
 * Case-insensitive, as SQLite's LIKE is for ASCII.
 *
 * @param text        free text from the search box
 * @param abilityList ability keys from ABILITY_FILTERS
 * @param prefix      table alias for the columns, e.g. 'c' for `c.oracle_text`
 * @returns {{ clause: string|null, params: string[] }}
 */

const any = (...phrases) => phrases.map((p) => ({ text: p }));

export const ABILITY_FILTERS = {
  draw: {
    label: 'Card draw',
    any: any(
      'draw a card', 'draws a card', 'draw an additional card', 'draws an additional card',
      'draw two cards', 'draws two cards', 'draw three cards', 'draws three cards',
      'draw four cards', 'draws four cards', 'draw five cards', 'draws five cards',
      'draw seven cards', 'draws seven cards', 'draw x cards', 'draws x cards',
      'draw cards', 'draws cards', 'draw that many', 'draws that many'
    )
  },
  discard: {
    label: 'Discard',
    any: any('discard')
  },
  mill: {
    label: 'Mill',
    // "Mill" became a keyword action in 2020; older cards spell it out.
    any: [
      ...any('mill'),
      { text: 'top', and: ['of', 'library into', 'graveyard'] }
    ]
  },
  removal: {
    label: 'Removal',
    any: any(
      'destroy target', 'exile target', 'damage to target creature',
      'damage to any target', 'damage to target planeswalker',
      'return target creature to its owner', 'return target nonland permanent to its owner',
      'target creature gets -', 'target player sacrifices', 'each opponent sacrifices'
    )
  },
  wipe: {
    label: 'Board wipe',
    any: any(
      'destroy all', 'exile all', 'damage to each creature',
      'all creatures get -', 'return all creatures', 'return all nonland permanents',
      'each player sacrifices'
    )
  },
  counter: {
    label: 'Counterspell',
    any: any('counter target')
  },
  ramp: {
    label: 'Ramp',
    // A land tapping for mana is not ramp, nor is a fetch land; a rock, a dork
    // or a Rampant Growth is.
    any: [
      { text: 'add {', notType: 'Land' },
      { text: 'add one mana', notType: 'Land' },
      { text: 'add two mana', notType: 'Land' },
      { text: 'mana of any', notType: 'Land' },
      { text: 'search your library for', and: ['land', 'onto the battlefield'], notType: 'Land' }
    ]
  },
  tutor: {
    label: 'Tutor',
    // Fetch lands search too; they are not what anyone means by a tutor.
    any: [{ text: 'search your library for', notType: 'Land' }]
  },
  selection: {
    label: 'Scry / surveil',
    any: any('scry', 'surveil')
  },
  lifegain: {
    label: 'Lifegain',
    any: [
      ...any('gain % life', 'gains % life'),
      { keyword: 'Lifelink' }
    ]
  },
  tokens: {
    label: 'Makes tokens',
    any: any('create % token')
  },
  recursion: {
    label: 'Graveyard recursion',
    any: any(
      'from your graveyard to your hand', 'from your graveyard to the battlefield',
      'from your graveyard onto the battlefield', 'card from your graveyard',
      'cards from your graveyard'
    )
  },
  sacrifice: {
    label: 'Sacrifice outlet',
    any: any('sacrifice a', 'sacrifice another', 'sacrifice x')
  }
};

/**
 * Words and "quoted phrases" from the box. Wildcards are stripped so a typed
 * `%` or `_` is not a wildcard.
 */
export function parseTextTerms(text) {
  const terms = [];
  const source = String(text || '');
  for (const match of source.matchAll(/"([^"]*)"|(\S+)/g)) {
    const term = (match[1] ?? match[2]).replace(/[%_"]/g, '').trim();
    if (term) terms.push(term);
  }
  return terms;
}

export function cardTextFilterSql(text, abilityList = [], prefix = '') {
  const col = (name) => (prefix ? `${prefix}.${name}` : name);
  const oracle = `COALESCE(${col('oracle_text')}, '')`;

  const clauses = [];
  const params = [];

  for (const term of parseTextTerms(text)) {
    clauses.push(`${oracle} LIKE ?`);
    params.push(`%${term}%`);
  }

  const keys = (Array.isArray(abilityList) ? abilityList : String(abilityList || '').split(','))
    .map((k) => String(k).trim())
    .filter((k) => ABILITY_FILTERS[k]);

  for (const key of [...new Set(keys)]) {
    const options = ABILITY_FILTERS[key].any.map((opt) => {
      if (opt.keyword) {
        params.push(`%,${opt.keyword},%`);
        return `(',' || REPLACE(COALESCE(${col('keywords')}, ''), ', ', ',') || ',') LIKE ?`;
      }
      const parts = [`${oracle} LIKE ?`];
      params.push(`%${opt.text}%`);
      for (const extra of opt.and || []) {
        parts.push(`${oracle} LIKE ?`);
        params.push(`%${extra}%`);
      }
      if (opt.notType) {
        parts.push(`COALESCE(${col('type_line')}, '') NOT LIKE ?`);
        params.push(`%${opt.notType}%`);
      }
      return `(${parts.join(' AND ')})`;
    });
    clauses.push(`(${options.join(' OR ')})`);
  }

  if (clauses.length === 0) return { clause: null, params: [] };
  return { clause: `(${clauses.join(' AND ')})`, params };
}
