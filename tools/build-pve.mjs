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

const FILE_ARG = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
const DATE_ARG = (process.argv.find(a => a.startsWith('--date=')) || '').slice(7) || null;

const raw = FILE_ARG
  ? JSON.parse(fs.readFileSync(FILE_ARG, 'utf8'))
  : await (await fetch(SRC)).json();

/* 자료 기준일은 **PokeMiners 가 GAME_MASTER 를 올린 날**이어야 합니다.
   빌드한 날짜를 적으면 열흘 묵은 자료가 오늘 것처럼 보입니다. */
async function repoDate(repo, path) {
  const r = await fetch(`https://api.github.com/repos/${repo}/commits?path=${path}&per_page=1`,
    { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'pogo-iv-build' } });
  if (!r.ok) throw new Error(repo + ' HTTP ' + r.status);
  return (await r.json())[0].commit.author.date.slice(0, 10);
}
/* 자료를 두 곳에서 받으므로 기준일은 **늦게 갱신된 쪽**입니다. */
async function sourceDate() {
  if (DATE_ARG) return DATE_ARG;
  const got = [];
  for (const [repo, path] of [
    ['PokeMiners/game_masters', 'latest/latest.json'],
    ['mgrann03/pokemon-resources', 'pogo_cm.json'],
  ]) {
    try { got.push(await repoDate(repo, path)); }
    catch (e) { console.error(`※ ${repo} 갱신일 확인 실패 (${e.message}).`); }
  }
  if (!got.length) {
    console.error('※ 어느 쪽 갱신일도 확인하지 못했습니다. 오늘 날짜로 적습니다.');
    return new Date().toISOString().slice(0, 10);
  }
  return got.sort().pop();
}

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

/* 메가 전용 3번째 기술 (메가레벨 4 에서 5000 메가에너지로 해금).
   VM_MOVE_TEMP_EVOLUTION_MEGA[_X|_Y]_V####_POKEMON_XXX 템플릿에 들어 있고,
   같은 이름의 일반 기술과는 위력·에너지가 다른 별개의 기술입니다.
   pvpoke 에는 없어서 여기서 챙기지 않으면 이 13마리가 과소평가됩니다.
   키는 "도감번호_폼접미사" 로, 앱의 speciesId(dragonite_mega, raichu_mega_x)와 맞춥니다. */
const VFX_FIX = { MYST_FIRE:'MYSTICAL_FIRE' };
const megaMoves = {};
for (const t of raw) {
  const m = t.data.moveSettings;
  if (!m || !/^VM_MOVE_TEMP_EVOLUTION_/.test(t.templateId)) continue;
  const dex = +(t.templateId.match(/V(\d{4})_POKEMON/) || [])[1];
  const evo = (t.templateId.match(/TEMP_EVOLUTION_([A-Z_]+?)_V\d{4}/) || [])[1];
  if (!dex || !evo) continue;
  const vfx = String(m.vfxName || '').toUpperCase();
  const base = VFX_FIX[vfx] || vfx;
  if (!moves[base]) throw new Error(`메가 전용기의 원본 기술을 못 찾음: ${t.templateId} (vfx ${vfx})`);
  megaMoves[dex + '_' + evo.toLowerCase()] =
    { t: T(m.pokemonType), p: m.power || 0, d: m.durationMs, e: m.energyDelta || 0, f: 0, base };
}

/* ── 메가 전용기 보강: mgrann03/pokemon-resources ──────────────────────────
   PokeMiners 는 1~2달에 한 번만 올라옵니다. 슈퍼맥스 전용기가 쏟아지는 지금은
   그 사이에 순위가 통째로 뒤집히므로 그때까지 기다릴 수 없습니다.
   mgrann03 은 같은 PokeMiners 를 원본으로 쓰되 **사람이 패치를 먼저 반영**해서
   며칠 안에 올라옵니다 (DialgaDex 가 쓰는 자료입니다).

   손으로 관리되는 곳이라 그대로 믿지 않습니다.
   PokeMiners 에도 있는 항목은 값을 하나하나 대조하고, 어긋나면 빌드를 멈춥니다.
   이 저장소가 멎어도 PokeMiners 에서 뽑은 것만 남으므로 조용히 이전 수준으로 돌아갑니다. */
const MG = 'https://raw.githubusercontent.com/mgrann03/pokemon-resources/main/';
const moveIdOf = n => n.replace(/\+$/, '').trim().toUpperCase().replace(/[ -]/g, '_').replace(/'/g, '');

async function overlayMegaMoves() {
  let cm, tm;
  try {
    [cm, tm] = await Promise.all([
      fetch(MG + 'pogo_cm.json').then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }),
      fetch(MG + 'pogo_pkm_manual_temp_moves.json').then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }),
    ]);
  } catch (e) {
    console.error(`※ mgrann03 자료를 받지 못했습니다 (${e.message}). PokeMiners 것만 씁니다.`);
    return 0;
  }
  const byName = Object.fromEntries(cm.map(m => [m.name, m]));
  let added = 0, checked = 0;
  for (const t of tm) {
    for (const mvName of (t.temp_cm || [])) {
      const mv = byName[mvName];
      if (!mv) { console.error(`※ ${t.name} 의 ${mvName} 수치를 못 찾았습니다.`); continue; }
      // 폼 접미사: pvpoke 의 speciesId 와 맞춘다 (raichu_mega_x, mewtwo_mega_y …)
      const sfx = t.form === 'MegaY' || / Y$/.test(t.name) ? 'mega_y'
                : / X$/.test(t.name) ? 'mega_x' : 'mega';
      const key = t.id + '_' + sfx;
      const base = moveIdOf(mvName);
      if (!moves[base]) { console.error(`※ ${mvName} 의 원본 기술(${base})이 없습니다.`); continue; }
      const next = { t: String(mv.type).toLowerCase(), p: mv.power, d: mv.duration, e: mv.energy_delta, f: 0, base };

      const cur = megaMoves[key];
      if (cur) {                                   // PokeMiners 에도 있는 것 → 대조
        checked++;
        const diff = ['t', 'p', 'd', 'e'].filter(k => cur[k] !== next[k]);
        if (diff.length) throw new Error(
          `메가 전용기 값이 두 출처에서 다릅니다: ${t.name} ${mvName}\n` +
          `  PokeMiners ${JSON.stringify(cur)}\n  mgrann03   ${JSON.stringify(next)}\n` +
          `  어긋난 항목: ${diff.join(', ')} — 어느 쪽이 맞는지 확인하고 고치세요.`);
      } else { megaMoves[key] = next; added++; }
    }
  }
  console.error(`mgrann03 대조 ${checked}건 일치, 새로 추가 ${added}건.`);
  return added;
}
/* pvpoke 와 GAME_MASTER 가 같은 기술을 다르게 부르는 곳이 있습니다.
   앱은 기술풀을 pvpoke 에서 가져오므로, 이름이 안 맞으면 그 기술이
   **조용히 계산에서 빠집니다**. 실제로 미래예지(FUTURE_SIGHT)가 그랬고
   출시 포켓몬 33종의 에스퍼 계산이 통째로 틀렸습니다 (2026-09-14 발견).
   그래서 pvpoke 쪽 이름으로도 찾을 수 있게 별칭을 함께 실어 둡니다. */
const MOVE_ALIAS = {
  FUTURE_SIGHT: 'FUTURESIGHT',                      // 출시 33종이 씁니다
  PYRO_BALL: 'PYROBALL',
  TECHNO_BLAST_DOUSE: 'TECHNO_BLAST_WATER',
  GULP_MISSILE_ARROKUDA: 'GULP_MISSILE_GULPING',
  GULP_MISSILE_PIKACHU: 'GULP_MISSILE_GORGING',
  AEGISLASH_CHARGE_AIR_SLASH: 'AIR_SLASH',
  AEGISLASH_CHARGE_PSYCHO_CUT: 'PSYCHO_CUT',
};
for (const [from, to] of Object.entries(MOVE_ALIAS)) {
  if (!moves[to]) throw new Error(`별칭이 가리키는 기술이 없습니다: ${from} → ${to}`);
  if (!moves[from]) moves[from] = moves[to];
}
// 히든파워는 GAME_MASTER 가 하나뿐이지만 pvpoke 는 타입별로 쪼갭니다. 타입만 갈아 끼워 만듭니다.
if (moves.HIDDEN_POWER) {
  for (const t of ['normal','fighting','flying','poison','ground','rock','bug','ghost','steel',
                   'fire','water','grass','electric','psychic','ice','dragon','dark']) {
    const id = 'HIDDEN_POWER_' + t.toUpperCase();
    if (!moves[id]) moves[id] = Object.assign({}, moves.HIDDEN_POWER, { t });
  }
}

// 별칭(FUTURE_SIGHT 등)을 다 만든 뒤에 보강해야 원본 기술을 제대로 찾습니다.
await overlayMegaMoves();

/* 감시: 메가레벨별 위력 배율이 GAME_MASTER 에 생기면 알려 준다.
   지금은 데이터에 없어서 앱이 커뮤니티 공개 수치(1 / 1.1 / 1.2 / 1.3)를 하드코딩하고 있습니다.
   여기 새 필드가 뜨면 그걸 정본으로 삼아 pve.json 에 실어야 합니다. */
const KNOWN_EFFECTS = new Set(['differentTypeAttackBoost','sameTypeAttackBoost','sameTypeExtraCatchCandy',
  'sameTypeExtraCatchXp','sameTypeExtraCatchCandyXlChance','selfCpBoostAdditionalLevel']);
const newEffects = new Set();
for (const t of raw) {
  const m = t.data.megaEvoLevelSettings;
  if (!m || !m.effects) continue;
  for (const k of Object.keys(m.effects)) if (!KNOWN_EFFECTS.has(k)) newEffects.add(k);
}
if (newEffects.size)
  console.error(`※ 메가레벨 효과에 못 보던 필드가 생겼습니다: ${[...newEffects].join(', ')}\n` +
                `   위력 배율이라면 index.html 의 MEGA_PLUS 하드코딩을 이 값으로 바꾸세요.`);

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
const body = { types: ORDER, K, cpm, chart, moves, megaMoves };
const ver = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 12);
const built = await sourceDate();

if (fs.existsSync(OUT)) {
  try {
    const old = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    if (old.ver === ver && old.built === built) {
      console.error(`pve.json — 내용도 기준일도 그대로 (ver ${ver}, 기준일 ${built}). 건드리지 않습니다.`);
      process.exit(0);
    }
  } catch { /* 깨진 파일이면 새로 만든다 */ }
}
fs.writeFileSync(OUT, JSON.stringify(Object.assign({ ver, built }, body)));

const nf = Object.values(moves).filter(m => m.f).length;
console.error(`pve.json — 기술 ${Object.keys(moves).length}개 (일반 ${nf} / 차지 ${Object.keys(moves).length - nf}) · 메가전용기 ${Object.keys(megaMoves).length} · 타입 ${ORDER.length} · CPM ${cpm.length} · ver ${ver} · 기준일 ${built} · ${fs.statSync(OUT).size} bytes`);
