/*
 * PokeMiners GAME_MASTER 에서 레이드 계산에 필요한 것만 뽑아 pve.json 을 만듭니다.
 *
 *   node tools/build-pve.mjs            내려받아서 만들기
 *   node tools/build-pve.mjs 파일.json  이미 받아 둔 원본으로 만들기
 *
 * 왜 이 파일이 필요한가
 *   pvpoke 데이터는 PvP 전용 수치만 있습니다 (카운터: 위력 8, 2턴).
 *   레이드는 수치가 완전히 다릅니다 (카운터: 위력 13, 1000ms).
 *   종족값·타입·기술풀·대기머는 pvpoke 것을 그대로 쓰므로,
 *   여기서는 **기술의 PvE 수치와 타입 상성표, 전투 상수**만 뽑습니다.
 *
 * GitHub Actions 가 매일 돌려서 바뀐 게 있으면 커밋합니다 (.github/workflows/pve.yml).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SRC = 'https://raw.githubusercontent.com/PokeMiners/game_masters/master/latest/latest.json';
const OUT = path.resolve(process.cwd(), 'pve.json');

const raw = process.argv[2]
  ? JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
  : await (await fetch(SRC)).json();

const T = s => String(s).replace('POKEMON_TYPE_', '').toLowerCase();

/* 기술: 위력 · 지속시간(ms) · 에너지 · 일반기 여부 */
const moves = {};
for (const t of raw) {
  const m = t.data.moveSettings;
  if (!m) continue;
  // movementId 가 숫자인 항목이 있어 templateId 에서 이름을 뽑는다
  const id = (t.templateId.match(/^V\d+_MOVE_(.+)$/) || [])[1];
  if (!id) continue;
  const fast = /_FAST$/.test(id);
  moves[id.replace(/_FAST$/, '')] = {
    t: T(m.pokemonType),
    p: m.power || 0,
    d: m.durationMs,
    e: m.energyDelta || 0,   // 일반기는 +, 차지기는 −
    f: fast ? 1 : 0,
  };
}

/* 타입 상성: chart[공격타입][방어타입]
   주의 — GAME_MASTER 의 POKEMON_TYPE_* 템플릿은 알파벳 순으로 나오지만
   attackScalar 배열의 인덱스는 아래 고정 순서를 따릅니다. 헷갈리면 상성표가
   통째로 어긋나므로, 만들고 나서 알려진 상성 몇 개로 반드시 검산합니다. */
const ORDER = ['normal','fighting','flying','poison','ground','rock','bug','ghost','steel',
               'fire','water','grass','electric','psychic','ice','dragon','dark','fairy'];
const scal = {};
for (const t of raw) {
  const e = t.data.typeEffective;
  if (e) scal[T(e.attackType)] = e.attackScalar;
}
const missing = ORDER.filter(t => !scal[t]);
if (missing.length) throw new Error('상성 자료에 없는 타입: ' + missing.join(', '));
const chart = {};
for (const a of ORDER) {
  chart[a] = {};
  ORDER.forEach((d, i) => { chart[a][d] = scal[a][i]; });
}
// 검산: 아는 상성이 안 맞으면 인덱스 순서가 바뀐 것이므로 여기서 멈춘다
const SANITY = [
  ['water','fire',1.6], ['water','grass',0.625], ['fighting','normal',1.6],
  ['normal','ghost',0.390625], ['electric','ground',0.390625], ['fairy','dragon',1.6],
  ['ground','flying',0.390625], ['ghost','psychic',1.6], ['ice','dragon',1.6],
];
for (const [a, d, want] of SANITY) {
  if (Math.abs(chart[a][d] - want) > 1e-6)
    throw new Error(`상성표 검산 실패: ${a}→${d} 가 ${chart[a][d]} (기대 ${want}). ORDER 를 확인하세요.`);
}

/* 전투 상수 (자속 1.2, 그림자 공격 1.2 등) */
const bs = raw.find(t => t.templateId === 'BATTLE_SETTINGS').data.battleSettings;
const K = {
  stab: bs.sameTypeAttackBonusMultiplier,
  shadowAtk: bs.shadowPokemonAttackBonusMultiplier,
  shadowDef: bs.shadowPokemonDefenseBonusMultiplier,
};

/* CPM (레벨 1 ~ 50, 0.5 단위) */
const cpm = raw.find(t => t.data.playerLevel).data.playerLevel.cpMultiplier;

/* 내용이 그대로면 파일도 그대로여야 합니다.
   빌드 시각을 그냥 넣으면 매일 새 커밋이 생기고, 그때마다 Pull 을 해야 합니다.
   그래서 내용 해시를 버전으로 삼고, 해시가 같으면 기존 파일을 손대지 않습니다. */
const body = { types: ORDER, K, cpm, chart, moves };
const ver = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 12);

let built = new Date().toISOString().slice(0, 10);
if (fs.existsSync(OUT)) {
  try {
    const old = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    if (old.ver === ver) {
      console.error(`pve.json — 내용 그대로 (ver ${ver}, 기준일 ${old.built}). 건드리지 않습니다.`);
      process.exit(0);
    }
  } catch { /* 깨진 파일이면 새로 만든다 */ }
}
fs.writeFileSync(OUT, JSON.stringify(Object.assign({ ver, built }, body)));

const nf = Object.values(moves).filter(m => m.f).length;
console.error(`pve.json — 기술 ${Object.keys(moves).length}개 (일반 ${nf} / 차지 ${Object.keys(moves).length - nf}) · 타입 ${ORDER.length} · CPM ${cpm.length} · ver ${ver} · 기준일 ${built} · ${fs.statSync(OUT).size} bytes`);
