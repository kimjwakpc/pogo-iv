/*
 * 회귀 테스트 — 포켓몬고 개체값 판독기
 *
 *   node test.mjs            평소 실행 (.pvcache 가 있으면 그걸 씀)
 *   node test.mjs --refresh  pvpoke 데이터를 새로 받아 캐시 갱신
 *   node test.mjs --file 다른파일.html
 *
 * 하는 일
 *   1) index.html 의 <script> 를 뽑아 문법 검사
 *   2) 브라우저 흉내(가짜 DOM·localStorage·fetch)를 씌워 실제로 실행
 *   3) CLAUDE.md 의 기대값 표를 그대로 대조
 *
 * 실패하면 종료코드 1 을 냅니다.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const REFRESH = argv.includes('--refresh');
const FILE = path.resolve(HERE, arg('--file', 'index.html'));
const CACHE = path.resolve(HERE, '.pvcache');

const RAW = 'https://raw.githubusercontent.com/pvpoke/pvpoke/master/src/data/';
const SOURCES = {
  'gamemaster.json': RAW + 'gamemaster.json',
  'rankings-1500.json': RAW + 'rankings/all/overall/rankings-1500.json',
  'rankings-2500.json': RAW + 'rankings/all/overall/rankings-2500.json',
};

/* ---------- 데이터 준비 ---------- */
async function getData() {
  fs.mkdirSync(CACHE, { recursive: true });
  const out = {};
  for (const [name, url] of Object.entries(SOURCES)) {
    const f = path.join(CACHE, name);
    if (!REFRESH && fs.existsSync(f)) {
      out[name] = JSON.parse(fs.readFileSync(f, 'utf8'));
      continue;
    }
    process.stderr.write(`  내려받는 중: ${name}\n`);
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${name} 받기 실패 (HTTP ${r.status})`);
    const j = await r.json();
    fs.writeFileSync(f, JSON.stringify(j));
    out[name] = j;
  }
  return out;
}

/* ---------- 가짜 DOM ---------- */
function fakeEl() {
  const store = { value: '', innerHTML: '', textContent: '', className: '', dataset: {}, style: {}, children: [], files: [] };
  return new Proxy(store, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'querySelector' || k === 'closest') return () => fakeEl();
      if (k === 'querySelectorAll') return () => [];
      if (k === 'checked') return false;
      return () => {};
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}
function fakeDocument() {
  const reg = new Map(); // 같은 선택자는 같은 노드를 돌려줘야 내용을 확인할 수 있다
  const doc = {
    els: reg,
    querySelector: s => { if (!reg.has(s)) reg.set(s, fakeEl()); return reg.get(s); },
    querySelectorAll: () => [],
    createElement: () => fakeEl(),
    addEventListener: () => {},
    body: fakeEl(),
  };
  return doc;
}
function fakeStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
    clear: () => m.clear(),
  };
}

/* ---------- 스크립트 추출 + 문법 검사 ---------- */
function extractScript(html) {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('<script> 블록을 찾지 못했습니다.');
  return m[1];
}

/* ---------- 실행 ---------- */
async function boot() {
  const html = fs.readFileSync(FILE, 'utf8');
  const src = extractScript(html);

  // 1) 문법 검사
  try { new Function(src); }
  catch (e) { throw new Error('JS 문법 오류: ' + e.message); }

  const data = await getData();
  const byUrl = {
    [SOURCES['gamemaster.json']]: data['gamemaster.json'],
    [SOURCES['rankings-1500.json']]: data['rankings-1500.json'],
    [SOURCES['rankings-2500.json']]: data['rankings-2500.json'],
  };

  const ctx = {
    document: fakeDocument(),
    localStorage: fakeStorage(),
    alert: () => {},
    prompt: () => null,
    confirm: () => true,
    console,
    Math, JSON, Date, Object, Array, String, Number, Boolean, Map, Set, RegExp, Promise, Error, isNaN, parseInt, parseFloat,
    URL: { createObjectURL: () => '' },
    Blob: class {},
    setTimeout, clearTimeout,
    fetch: async (u) => {
      if (!(u in byUrl)) throw new Error('예상 못 한 fetch 대상: ' + u);
      return { ok: true, json: async () => byUrl[u], text: async () => JSON.stringify(byUrl[u]) };
    },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);

  // 내부 바인딩(const/let)을 밖으로 노출시키는 꼬리표
  const epilogue = `
;globalThis.__T = {
  evalMon, evalStage, search, rankAll, xlNeeded, nameKo, moveKo,
  levelFromCP, maxLevel, calcCP, cpm, chainOf, megaOf,
  showStamp, parseTS, fmtDay, PATCHES,
  FORM_KO, NOT_FORM, FORM_KEEP, KO_NAME,
  get GM(){return GM}, get IDX(){return IDX}, get R15(){return R15}, get R25(){return R25},
  get CFG(){return CFG}
};`;
  new vm.Script(src + epilogue, { filename: 'index.html<script>' }).runInContext(ctx);

  // load() 가 끝날 때까지 대기
  for (let i = 0; i < 200 && !ctx.__T.GM; i++) await new Promise(r => setTimeout(r, 20));
  if (!ctx.__T.GM) throw new Error('데이터 적재(load)가 끝나지 않았습니다.');
  ctx.__T.$ = s => ctx.document.querySelector(s);
  return ctx.__T;
}

/* ---------- 검사 항목 ---------- */
const results = [];
function check(label, actual, expected) {
  const ok = String(actual) === String(expected);
  results.push({ ok, label, actual, expected });
}

function findMon(T, q) {
  const hits = T.search(q);
  if (!hits.length) throw new Error(`"${q}" 를 찾지 못했습니다.`);
  return hits[0];
}

/** 진화 계통 전체에서 speciesId 가 정확히 일치하는 단계를 찾아 리그 결과를 낸다 */
function leagueOf(T, mon, a, d, h, cap) {
  const st = T.evalStage(mon, a, d, h, null);
  return st.leagues.find(L => L.cap === cap);
}

async function main() {
  process.stderr.write(`대상 파일: ${FILE}\n`);
  const T = await boot();
  process.stderr.write(`gamemaster ${T.GM.pokemon.length}종 · 1500위 ${T.R15.size} · 2500위 ${T.R25.size}\n\n`);

  // 이름 → speciesId 가 맞는지 먼저 밝혀 둔다 (한글명 오인 방지)
  const cases = [
    { q: '따라큐', ivs: [1, 14, 15], cap: 1500, rank: 1, lv: 25.5, cp: 1500 },
    { q: '갸라도스', ivs: [0, 14, 15], cap: 1500, rank: 1, pct: '100.0', lv: 16.5, cp: 1499 },
    { q: '갸라도스', ivs: [0, 15, 14], cap: 2500, rank: 1, pct: '100.0', lv: 27.5, cp: 2500 },
    { q: '요가램', ivs: [5, 15, 15], cap: 1500, rank: 1, lv: 50 },
    { q: '전룡', ivs: [0, 13, 15], cap: 2500, rank: 1, pct: '100.0', lv: 36 },
    { q: '아머까오', ivs: [2, 15, 15], cap: 2500, rank: 10, pct: '99.5', lv: 47.5, cp: 2499 },
  ];

  for (const c of cases) {
    const mon = findMon(T, c.q);
    const [a, d, h] = c.ivs;
    const league = c.cap === 1500 ? '슈퍼' : '하이퍼';
    const tag = `${c.q}(${mon.speciesId}) ${a}/${d}/${h} ${league}`;
    const L = leagueOf(T, mon, a, d, h, c.cap);
    if (!L || !L.mine) { check(tag, '리그 진입 불가', '순위 산출'); continue; }
    check(`${tag} 순위`, L.pos, c.rank);
    check(`${tag} 레벨`, L.mine.l, c.lv);
    if (c.cp !== undefined) check(`${tag} CP`, L.mine.cp, c.cp);
    if (c.pct !== undefined) check(`${tag} 최적대비`, L.pct.toFixed(1), c.pct);
  }

  check('XL사탕 Lv40→50', T.xlNeeded(40, 50), 296);

  // 인수인계 문서에 적힌 한글명 오인 사례 — 최종 진화가 맞는지 확인
  const nameCases = [
    ['소곤룡', '폭음룡'], ['이어롤', '이어롭'], ['탱그릴', '탱탱겔'],
    ['나오하', '마스카나'], ['냐오불', '어흥염'], ['리그레', '벰크'],
    ['콕코구리', '왕큰부리'], ['초롱순', '킬라플로르'], ['왕눈해', '독파리'],
    ['방패톱스', '바리톱스'], ['대굴레오', '씨카이저'], ['니로우', '돈크로우'],
  ];
  for (const [from, want] of nameCases) {
    let got;
    try {
      const mon = findMon(T, from);
      const chain = T.chainOf(mon).map(sp => T.nameKo(sp));
      got = chain[chain.length - 1];
    } catch (e) { got = '(찾지 못함)'; }
    check(`계통 확인 ${from} → 최종`, got, want);
  }

  // 데이터 기준일 표시
  const ts = T.parseTS(T.GM.timestamp);
  check('gamemaster timestamp 해석', ts instanceof Date && !isNaN(ts), true);
  check('기준일 문구에 날짜 포함', T.$('#stat').innerHTML.includes(T.fmtDay(ts)), true);
  {
    const keep = T.PATCHES.slice();
    const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const only = (d, label) => { T.PATCHES.length = 0; T.PATCHES.push([ymd(d), label]); T.showStamp(); };

    // 자료보다 나중에 지나간 패치 → 알림이 켜져야 한다
    only(new Date(ts.getTime() + 86400000), '테스트 패치');
    check('자료보다 늦은 지난 패치 → 알림 켜짐', T.$('#dbar').className, 'dbar on');
    check('알림에 패치 이름 표기', T.$('#dbar').innerHTML.includes('테스트 패치'), true);

    // 자료보다 먼저 지나간 패치 → 이미 반영된 것이므로 조용해야 한다
    only(new Date(ts.getTime() - 86400000), '오래된 패치');
    check('자료에 이미 반영된 패치 → 알림 꺼짐', T.$('#dbar').className, 'dbar');

    // 아직 오지 않은 패치 → 알리지 않는다
    only(new Date(Date.now() + 3 * 86400000), '미래 패치');
    check('아직 안 온 패치 → 알림 꺼짐', T.$('#dbar').className, 'dbar');

    T.PATCHES.length = 0; keep.forEach(p => T.PATCHES.push(p));
    T.showStamp();
  }

  // 폼 한글명 — 빠진 매핑이 있으면 영문이 그대로 노출된다
  {
    const tokens = new Map();
    for (const p of T.GM.pokemon)
      for (const t of (p.speciesName.match(/\((.*?)\)/g) || []).map(x => x.slice(1, -1)))
        if (!tokens.has(t)) tokens.set(t, p.speciesName);
    const miss = [...tokens.keys()].filter(t => !T.NOT_FORM.has(t) && !T.FORM_KEEP.has(t) && !(t in T.FORM_KO));
    check('매핑 안 된 폼 토큰', miss.length ? miss.join(', ') : '없음', '없음');

    // 원문 토큰이 화면 이름에 그대로 남으면 안 된다 (FORM_KEEP 은 일부러 남기는 것)
    const leaked = [];
    for (const p of T.GM.pokemon) {
      const ko = T.nameKo(p);
      for (const t of (p.speciesName.match(/\((.*?)\)/g) || []).map(x => x.slice(1, -1)))
        if (!T.FORM_KEEP.has(t) && ko.includes(t)) leaked.push(`${ko} (${t})`);
    }
    check('원문 토큰이 남은 이름', leaked.length ? leaked.slice(0, 5).join(' / ') : '없음', '없음');
  }

  // 이름 표기 개별 확인 (괄호가 폼이 아닌 것 + 고친 폼)
  const nameSpot = [
    ['type_null', '타입:널'],           // Type (Null) — 괄호가 이름의 일부
    ['mime_jr', '흉내내'],              // Mime (Jr)  — 위와 같음
    ['burmy_plant', '초목도롱 도롱충이'],
    ['burmy_trash', '슈레도롱 도롱충이'],
    ['cherrim_sunny', '포지폼 체리꼬'],
    ['castform_rainy', '빗방울 캐스퐁'],
    ['rotom_fan', '스핀 로토무'],
    ['genesect_douse', '아쿠아카세트 게노세크트'],
    ['eiscue_ice', '아이스페이스 빙큐보'],
    ['arceus_ice', '얼음 아르세우스'],
    ['silvally_bug', '벌레 실버디'],
    ['zacian_hero', '역전의 용사 자시안'],
    ['darmanitan_standard', '노말모드 불비달마'],
    ['oricorio_pom_pom', '파칙파칙스타일 춤추새'],
    ['lycanroc_midnight', '한밤중 루가루암'],
    ['calyrex_ice_rider', '백마 탄 버드렉스'],
    ['wishiwashi_school', '군집 약어리'],
  ];
  for (const [sid, want] of nameSpot) {
    const p = T.IDX.get(sid);
    check(`이름 ${sid}`, p ? T.nameKo(p) : '(gamemaster에 없음)', want);
  }

  // 출력
  let fail = 0;
  for (const r of results) {
    if (r.ok) console.log(`  통과   ${r.label} = ${r.actual}`);
    else { fail++; console.log(`  실패   ${r.label} : 기대 ${r.expected} / 실제 ${r.actual}`); }
  }
  console.log(`\n${results.length}건 중 ${results.length - fail}건 통과, ${fail}건 실패`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('오류: ' + e.message); process.exit(1); });
