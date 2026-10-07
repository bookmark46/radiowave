/**
 * 无意识电波 · App 前端
 * SillyTavern client extension
 *
 * 职责：
 *   1. 在聊天界面挂一个悬浮入口，打开「手机」面板（主页 / 档案 / 电波 / 地图）
 *   2. 人物档案、电波列表、主角状态全部存进 chatMetadata（每档独立）
 *   3. 电波增删改 → 通过 STscript 同步进「聊天绑定世界书」
 *   4. AI 回复里的 <电波状态> 块 → 解析合并；解析失败则静默二次请求兜底
 *
 * 所有数据都走 chatMetadata + 世界书，不占角色卡本体，也不额外占用上下文。
 */

const MODULE_NAME = 'radiowave_app';
const STATE_BLOCK_RE = /<电波状态>([\s\S]*?)<\/电波状态>/;

/** 便捷取 context —— 不要缓存引用，切聊天时会变 */
const C = () => SillyTavern.getContext();
const log = (...a) => console.log('[无意识电波]', ...a);
const warn = (...a) => console.warn('[无意识电波]', ...a);
/** 酒馆全局 toastr 不一定可用，包一层 */
const toast = (kind, msg) => {
    try {
        if (typeof toastr !== 'undefined' && toastr?.[kind]) toastr[kind](msg);
        else log(msg);
    } catch { log(msg); }
};

/** 扩展版本 —— 出问题时先看控制台这一行，确认加载的是哪一版 */
const EXT_VERSION = '0.13.1';

/* ---------- 性别识别 ----------
 * AI 在中文语境下会写 "女" / "女生" / "女性"，英文语境会写 "female"。
 * 早期版本只认精确的 "female"，导致中文卡里所有新人物都被当成男性丢掉。
 * 现在只在**明确是男性**时才拒绝，其余（含未知）一律放行。
 */
const FEMALE_TOKENS = ['female', 'f', 'woman', 'girl', '女', '女性', '女人', '女生', '女孩', '妹子', '姑娘'];
const MALE_TOKENS = ['male', 'm', 'man', 'boy', '男', '男性', '男人', '男生', '男孩', '男的', '爷们'];

function genderOf(v) {
    const s = String(v ?? '').trim().toLowerCase();
    if (!s) return 'unknown';
    if (FEMALE_TOKENS.includes(s)) return 'female';
    if (MALE_TOKENS.includes(s)) return 'male';
    // 兜底：包含关系，但要求「男」不能只是出现在无关词里
    if (/男/.test(s) && !/女/.test(s)) return 'male';
    if (/女/.test(s)) return 'female';
    return 'unknown';
}

/* ============================================================
   一、默认数据
   ============================================================ */

/** 地点表：parent 形成层级，city 为顶层；match 是用于从中文描述里推断地点的别名
 *  x / y 是 0-100 的百分比坐标（左上为原点），会写进世界书让 AI 理解方位关系
 *  desc 是 30-50 字的地点介绍，玩家可编辑
 */
const DEFAULT_LOCS = {
    /* ---------- 大地图：临江市，被临江分成两岸 ---------- */
    home: {
        name: '家', icon: '🏠', parent: 'city', x: 14, y: 18,
        match: ['家', '卧室', '客厅', '玄关', '阳台'],
        desc: '西岸老城区一栋六层居民楼的四楼，两室一厅。阳台朝南，常年晾着衣服，客厅的电视机用了十一年。',
    },
    school: {
        name: '市立三中', icon: '🏫', parent: 'city', x: 15, y: 60,
        match: ['市立三中', '三中', '学校', '校园', '高中'],
        desc: '西岸老城区的公立高中，1954 年建校，占了整整一个街区。红砖教学楼和四百米跑道都旧了，但还结实。',
    },
    univ: {
        name: '立德大学', icon: '🎓', parent: 'city', x: 37, y: 84,
        match: ['立德大学', '立德', '大学', '校园'],
        desc: '紧挨市立三中东南侧的综合性大学，1962 年建校。校区比三中大出三倍，梧桐树遮住了大半条主路。',
    },
    police: {
        name: '警局', icon: '🚓', parent: 'city', x: 71, y: 20,
        match: ['警局', '警察局', '警署', '警队'],
        desc: '东岸新城区的灰白色六层办公楼，门口停着四辆警车。二楼三号办公区被隔板分出一个角落，堆满了旧卷宗。',
    },
    diner: {
        name: '餐馆', icon: '🍜', parent: 'city', x: 67, y: 50,
        match: ['秦记', '小馆', '餐馆', '饭馆', '面馆'],
        desc: '西岸老巷里的秦记小馆，四张桌子一个灶台，菜单是手写的木板。招牌糖醋排骨和热汤面，价格十年没涨过。',
    },
    office: {
        name: '写字楼', icon: '🏢', parent: 'city', x: 70, y: 79,
        match: ['写字楼', '报社', '晚报', '临江晚报', '公司', '大厦'],
        desc: '东岸主干道旁的六栋玻璃幕墙写字楼，最高的那栋三十二层。临江晚报社在第三栋三楼，采编室很挤。',
    },

    /* ---------- 市立三中 · 校园平面图 ---------- */
    teach: {
        name: '教学楼', icon: '🏫', parent: 'school', x: 24, y: 22,
        match: ['教学楼', '教室', '连廊', '班级'],
        desc: '三栋红砖教学楼，楼梯间的墙皮补过好几层。2 年 A 班在二号楼二层东头，窗外正对着一排香樟。',
    },
    canteen: {
        name: '食堂', icon: '🍚', parent: 'school', x: 74, y: 24,
        match: ['食堂'],
        desc: '一栋独立的平房，中午十一点四十开始排队。红烧肉是招牌，去晚了就没有，高一的学生总是抢不到。',
    },
    lib: {
        name: '图书馆', icon: '📚', parent: 'school', x: 50, y: 44,
        match: ['图书馆', '阅览室'],
        desc: '二层东侧，藏书不多但很安静。靠窗的位置下午会有阳光，是全校最难抢的座位。',
    },
    lab: {
        name: '实验楼', icon: '⚗', parent: 'school', x: 24, y: 52,
        match: ['实验楼', '实验室'],
        desc: '五层，化学和物理实验室都在这里。三楼最里面那间常年锁着，据说通风橱坏了没修。',
    },
    admin: {
        name: '办公楼', icon: '🏛', parent: 'school', x: 74, y: 52,
        match: ['办公楼', '教务处', '学生处', '校长室'],
        desc: '一栋三层小楼，教务处、学生处、校长室都在里面。走廊尽头那间总关着门。',
    },
    dorm_f: {
        name: '女生宿舍', icon: '🛏', parent: 'school', x: 24, y: 78,
        match: ['女生宿舍', '女寝'],
        desc: '四号楼，四人间，楼下有铁门，十点整落锁。阳台上晾满了校服，风一吹像一整排白旗。',
    },
    dorm_m: {
        name: '男生宿舍', icon: '🛏', parent: 'school', x: 50, y: 82,
        match: ['男生宿舍', '男寝'],
        desc: '三号楼，四人间，熄灯十点半。走廊尽头的水房常年漏水，宿管王阿姨每晚要巡三趟。',
    },
    woods: {
        name: '树林', icon: '🌳', parent: 'school', x: 12, y: 40,
        match: ['树林', '香樟林', '小树林'],
        desc: '操场东边的一片香樟林，占地不大但树很密。白天没人去，晚自习前常有学生翻墙出去上网。',
    },
    field: {
        name: '体育场', icon: '⚽', parent: 'school', x: 76, y: 78,
        match: ['体育场', '操场', '跑道', '球场'],
        desc: '四百米跑道，中间是快秃了的草坪。啦啦队晚上在这里训练，体育课测八百米也在这里。',
    },

    /* ---------- 立德大学 · 校园平面图 ---------- */
    u_teach: {
        name: '教学楼', icon: '🏫', parent: 'univ', x: 24, y: 22,
        match: ['大学教学楼', '阶梯教室'],
        desc: '六栋连体的教学楼群，编号从 A 到 F。A 栋最大，能坐四百人的阶梯教室就在一楼。',
    },
    u_canteen: {
        name: '食堂', icon: '🍚', parent: 'univ', x: 74, y: 24,
        match: ['大学食堂'],
        desc: '三层的学生食堂，一楼最便宜三楼的菜最贵。晚上九点以后只开一楼，卖夜宵和烤串。',
    },
    u_lib: {
        name: '图书馆', icon: '📚', parent: 'univ', x: 50, y: 44,
        match: ['大学图书馆'],
        desc: '全校最高的那栋建筑，八层，藏书四十万册。顶楼的自习室通宵开放，考试周一座难求。',
    },
    u_lab: {
        name: '实验楼', icon: '⚗', parent: 'univ', x: 24, y: 52,
        match: ['大学实验楼'],
        desc: '理工科的地盘，地下室放着一台早就停用的旧加速器。晚上十点以后整栋楼只剩值班保安。',
    },
    u_admin: {
        name: '办公楼', icon: '🏛', parent: 'univ', x: 74, y: 52,
        match: ['大学办公楼', '行政楼'],
        desc: '行政楼，八层，教务处在一楼。办手续永远要跑三趟，这是全校学生的共识。',
    },
    u_dorm_f: {
        name: '女生宿舍', icon: '🛏', parent: 'univ', x: 24, y: 78,
        match: ['大学女生宿舍'],
        desc: '东区两栋高层，四人间带阳台。楼下有门禁和保安，外卖只能送到大门口。',
    },
    u_dorm_m: {
        name: '男生宿舍', icon: '🛏', parent: 'univ', x: 50, y: 84,
        match: ['大学男生宿舍'],
        desc: '西区七八九号楼，六人间，没有独立卫浴。楼下小卖部开到凌晨一点，生意一直很好。',
    },
    u_woods: {
        name: '树林', icon: '🌳', parent: 'univ', x: 12, y: 40,
        match: ['梧桐林', '大学树林'],
        desc: '校园东北角的一片梧桐林，中间有条碎石小路。傍晚很多人在里面散步，也有人在那儿吵架。',
    },
    u_field: {
        name: '体育场', icon: '⚽', parent: 'univ', x: 76, y: 78,
        match: ['大学体育场', '看台'],
        desc: '带看台的标准体育场，能容纳三千人。校运会和迎新晚会都在这里办，晚上跑道上人很多。',
    },
};

const CITY_META = { title: '临江市', sub: '被河流分成两岸的城市 · 点击地点查看详情' };

/** NPC 档案的四大区域定义 —— UI 与迁移都按这份表走，加字段只改这里 */
const NPC_REGIONS = [
    {
        key: 'base', label: '基础档案', icon: '👗',
        fields: [['top', '上装'], ['bottom', '下装'], ['underwear', '内衣'], ['feet', '脚部'], ['accessory', '配饰']],
    },
    {
        key: 'feature', label: '容貌特征', icon: '✧',
        fields: [['hair', '发型'], ['face', '脸型'], ['skin', '皮肤'], ['qizhi', '气质']],
    },
    {
        key: 'body', label: '身体数据', icon: '◇', typed: true,
        // typed: 每个小标题右侧显示一个同字号标签
        fields: [['chest', '胸部'], ['waist', '腰部'], ['hip', '臀部'], ['leg', '腿部']],
        // 胸部的标签固定是罩杯，其余三个是「XX型」
        badgeLabel: { chest: 'cup', waist: 'type', hip: 'type', leg: 'type' },
    },
    {
        key: 'priv', label: '隐私档案', icon: '🔒', collapsed: true,
        fields: [['front', '前庭 / 小穴'], ['back', '后庭 / 菊穴']],
    },
    { key: 'exp', label: '经验档案', icon: '❖', collapsed: true, kind: 'exp' },
];

/** 旧字段名 → 新区域字段 的迁移映射 */
const WEAR_MIGRATION = {
    发型: ['feature', 'hair'], 脸型: ['feature', 'face'], 皮肤: ['feature', 'skin'],
    上装: ['base', 'top'], 下装: ['base', 'bottom'], 内衣: ['base', 'underwear'],
    脚部: ['base', 'feet'], 鞋子: ['base', 'feet'], 配饰: ['base', 'accessory'],
};

function emptyRegions() {
    const out = {};
    for (const r of NPC_REGIONS) {
        if (r.kind === 'exp') { out.exp = { count: 0, virgin: true, kinks: '' }; continue; }
        out[r.key] = {};
        for (const [f] of r.fields) out[r.key][f] = r.typed ? { desc: '', type: '' } : '';
    }
    return out;
}

/** 把 v1 的 {wear:[[部位,描述]], personality} 升级成 v2 的区域结构 */
function migrateNpc(n) {
    // 1) 先把四大区域的结构建出来 —— 迁移需要目标字段已经就位
    const blank = emptyRegions();
    for (const r of NPC_REGIONS) {
        if (r.kind === 'exp') {
            n.exp = { ...blank.exp, ...(n.exp && typeof n.exp === 'object' ? n.exp : {}) };
            continue;
        }
        if (!n[r.key] || typeof n[r.key] !== 'object') n[r.key] = {};
        for (const [f] of r.fields) {
            if (r.typed) {
                const cur = n[r.key][f];
                n[r.key][f] = (cur && typeof cur === 'object')
                    ? { desc: String(cur.desc ?? ''), type: String(cur.type ?? '') }
                    : { desc: typeof cur === 'string' ? cur : '', type: '' };
            } else if (typeof n[r.key][f] !== 'string') {
                n[r.key][f] = n[r.key][f] == null ? '' : String(n[r.key][f]);
            }
        }
    }

    // 2) v1 的 wear 数组 → 各区域字段（目标为空才写，不覆盖已有值）
    if (Array.isArray(n.wear) && n.wear.length) {
        for (const w of n.wear) {
            if (!Array.isArray(w) || w.length < 2) continue;
            const map = WEAR_MIGRATION[String(w[0]).trim()];
            if (!map) continue;
            const [rk, fk] = map;
            if (typeof n[rk]?.[fk] === 'string' && !n[rk][fk]) n[rk][fk] = String(w[1]);
        }
        delete n.wear;
    }

    // 3) v1 的 personality → feature.qizhi
    if (n.personality && !n.feature.qizhi) n.feature.qizhi = String(n.personality);
    if (n.personality !== undefined) delete n.personality;

    if (typeof n.gender !== 'string') n.gender = 'female';
    if (typeof n.isSyncer !== 'boolean') n.isSyncer = false;
    if (typeof n.hidden !== 'boolean') n.hidden = false;
    return n;
}

const DEFAULT_STATE = {
    version: 2,
    day: 1,
    time: '08:32',
    player: {
        name: '',
        title: '电波持有者',
        identity: '市立三中 · 高二',
        age: 17,
        sub: '',
        place: 'home',
        placeText: '家 · 卧室',
        outfit: '洗得发白的灰蓝色连帽卫衣，袖口磨出毛边。胸口挂着一部没有品牌标识的白色手机。',
        note: '',
    },
    npcs: [],
    waves: [],
    seeded: false,
    customLocs: {},   // 玩家自建地点
    locEdits: {},     // 玩家对预设地点的改名/改介绍
    knownLocs: ['home', 'school', 'univ', 'police', 'diner', 'office'],
    settings: {
        rationalize: true,   // 电波合理化改写：开=视为常识，关=只控制身体不改意识
        onlyFemale: true,    // 档案仅收录女性角色
        syncResist: true,    // 同步者抵抗：其受到的电波效果减半
    },
    ui: { page: 'home', mapView: 'city' },
};

const DEFAULT_SETTINGS = Object.freeze({
    alwaysShowLauncher: false,
    autoExtract: true,
    syncLorebook: true,
    quietFallback: true,
});

/* ============================================================
   二、状态读写
   ============================================================ */

function getSettings() {
    const { extensionSettings } = C();
    if (!extensionSettings[MODULE_NAME]) extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], k)) extensionSettings[MODULE_NAME][k] = DEFAULT_SETTINGS[k];
    }
    return extensionSettings[MODULE_NAME];
}

/** 读取角色卡里预置的初始档案（存在 extensions.radiowave.seed，不进提示词） */
function getSeed() {
    try {
        const ch = C().characters?.[C().characterId];
        const seed = ch?.data?.extensions?.radiowave?.seed;
        return (seed && typeof seed === 'object') ? seed : null;
    } catch { return null; }
}

function getState() {
    const { chatMetadata } = C();
    if (!chatMetadata[MODULE_NAME]) {
        chatMetadata[MODULE_NAME] = structuredClone(DEFAULT_STATE);
        // 主角名默认取 persona
        try {
            const n1 = C().name1;
            if (n1) chatMetadata[MODULE_NAME].player.name = n1;
        } catch { /* ignore */ }
        // 用卡里预置的初始档案播种（失败也没关系，ensureSeeded 会在后面重试）
        ensureSeeded();
    }
    const s = chatMetadata[MODULE_NAME];
    // 补齐新版本字段
    for (const k of Object.keys(DEFAULT_STATE)) {
        if (!Object.hasOwn(s, k)) s[k] = structuredClone(DEFAULT_STATE[k]);
    }
    if (!Array.isArray(s.npcs)) s.npcs = [];
    if (!Array.isArray(s.waves)) s.waves = [];
    if (!s.ui) s.ui = { page: 'home', mapView: 'city' };
    if (!s.settings || typeof s.settings !== 'object') s.settings = structuredClone(DEFAULT_STATE.settings);
    for (const k of Object.keys(DEFAULT_STATE.settings)) {
        if (typeof s.settings[k] !== 'boolean') s.settings[k] = DEFAULT_STATE.settings[k];
    }
    // v1 → v2：把 wear / personality 升级成四大区域
    if (s.version < 2) {
        s.npcs.forEach(migrateNpc);
        s.version = 2;
    }
    // 兜底：万一是「先建了空状态、之后角色数据才加载完」的顺序，这里补种
    ensureSeeded();
    return s;
}

/* ------------------------------------------------------------
 * 初始档案播种
 * 坑：characters[chid].data 是「浅加载」的，角色卡没被真正打开前可能读不到。
 * 所以这个函数必须能被反复调用，直到成功为止。
 * ------------------------------------------------------------ */
let _seedTried = 0;

/** 诊断：把 seed 读取路径上每一环的结果摊开，出问题时一眼看出卡在哪 */
function seedProbe() {
    const ctx = C();
    const ch = ctx.characters?.[ctx.characterId];
    return {
        当前角色索引: ctx.characterId,
        角色总数: ctx.characters?.length ?? 0,
        角色名: ch?.name,
        有data字段: !!ch?.data,
        data的键: ch?.data ? Object.keys(ch.data).slice(0, 8) : null,
        有extensions: !!ch?.data?.extensions,
        extensions的键: ch?.data?.extensions ? Object.keys(ch.data.extensions) : null,
        有radiowave: !!ch?.data?.extensions?.radiowave,
        有seed: !!ch?.data?.extensions?.radiowave?.seed,
        seed里的人数: ch?.data?.extensions?.radiowave?.seed?.npc?.length ?? 0,
    };
}

function ensureSeeded(force = false) {
    const { chatMetadata } = C();
    const st = chatMetadata?.[MODULE_NAME];
    if (!st) return false;
    if (!force) {
        if (st.seeded) return false;
        if (st.npcs.length) { st.seeded = true; return false; }   // 已经有数据，不用种
    }

    const seed = getSeed();
    if (!seed) {
        _seedTried++;
        // 前几次每次都报，之后每 10 次报一次，避免刷屏
        if (_seedTried <= 3 || _seedTried % 10 === 0) {
            warn(`读不到卡片 seed（第 ${_seedTried} 次尝试）。诊断：`, seedProbe());
        }
        return false;
    }

    try {
        const raw = JSON.parse(JSON.stringify(seed));
        if (raw.settings) Object.assign(st.settings, raw.settings);
        applyStatePayload(st, raw);
        st.npcs.forEach(x => { x.isNew = false; });
        // 起始电波标记为「尚未同步」，等真正开始聊天再写进世界书
        st.waves.forEach((w, i) => {
            w.id = w.id ?? (Date.now() + i);
            w.origin = 'seed';
            w.synced = false;
            w.loreUid = null;
            if (!['on', 'pending', 'expired'].includes(w.state)) w.state = 'on';
        });
        st.seeded = true;
        log(`已从角色卡播种初始档案：${st.npcs.length} 人 / ${st.waves.length} 条电波`);
        saveState();
        return true;
    } catch (e) {
        warn('播种失败', e);
        return false;
    }
}

async function saveState() {
    try { await C().saveMetadata(); } catch (e) { warn('saveMetadata 失败', e); }
}

/* 地点工具 */
/**
 * 合成最终地点表：内置 → 角色卡覆盖 → 玩家改名改介绍 → 玩家自建地点
 * 注意：这里直接读 chatMetadata，不走 getState()，否则会 seed → applyStatePayload → getLocs 死循环。
 */
function getLocs() {
    const out = {};
    for (const [k, v] of Object.entries(DEFAULT_LOCS)) out[k] = { ...v };

    // 1) 角色卡 override
    try {
        const ov = C().characters?.[C().characterId]?.data?.extensions?.radiowave?.locs;
        if (ov && typeof ov === 'object') {
            for (const [k, v] of Object.entries(ov)) {
                if (v && typeof v === 'object') out[k] = { ...(out[k] || {}), ...v };
            }
        }
    } catch { /* ignore */ }

    // 2) 玩家对预设地点的改名 / 改介绍
    try {
        const edits = C().chatMetadata?.[MODULE_NAME]?.locEdits;
        if (edits && typeof edits === 'object') {
            for (const [k, v] of Object.entries(edits)) {
                if (out[k] && v && typeof v === 'object') out[k] = { ...out[k], ...v };
            }
        }
    } catch { /* ignore */ }

    // 3) 玩家自建地点
    try {
        const custom = C().chatMetadata?.[MODULE_NAME]?.customLocs;
        if (custom && typeof custom === 'object') {
            for (const [k, v] of Object.entries(custom)) {
                if (v && typeof v === 'object') out[k] = { ...v, custom: true };
            }
        }
    } catch { /* ignore */ }

    return out;
}

/** 返回某地点及其所有后代 id */
function locTree(locs, id) {
    const out = [id];
    for (const k of Object.keys(locs)) {
        if (locs[k].parent === id && !out.includes(k)) out.push(...locTree(locs, k));
    }
    return out;
}

function locLabel(locs, id) {
    return locs[id]?.name ?? id ?? '未知';
}

/** 该地点（含子地点）的人数 —— 隐藏角色不计入 */
function peopleAt(state, locs, pinId) {
    const ids = locTree(locs, pinId);
    return state.npcs.filter(n => !n.hidden && n.loc && ids.includes(n.loc));
}

/** 档案里可见的角色（不含隐藏） */
function visibleNpcs(state) {
    return (state.npcs || []).filter(n => !n.hidden);
}
/** 被隐藏的角色 */
function hiddenNpcs(state) {
    return (state.npcs || []).filter(n => n.hidden);
}

/* ============================================================
   三、程序化头像（发色 / 发型 / 眼睛 / 配饰 参数化）
   ============================================================ */

let _uid = 0;
const HAIR_PALETTE = ['#f2a0bd', '#e0553c', '#8b5cf6', '#0ea5e9', '#f59e0b', '#10b981', '#7a4a2e', '#4a4258', '#d946ef', '#2f3a4d'];
const EYE_PALETTE = ['#c8507e', '#8a3a2c', '#4a3f6b', '#33506b', '#6b3f22', '#3d3550', '#7c3aed'];
const STYLES = ['twintail', 'bob', 'long', 'short'];

function hashStr(s) {
    let h = 0;
    for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) | 0;
    return Math.abs(h);
}

function autoLook(name) {
    const h = hashStr(name);
    return {
        hair: HAIR_PALETTE[h % HAIR_PALETTE.length],
        hairStyle: STYLES[Math.floor(h / 7) % STYLES.length],
        eye: EYE_PALETTE[Math.floor(h / 3) % EYE_PALETTE.length],
        accessory: h % 11 === 0 ? 'catear' : 'none',
    };
}

/**
 * 头像三级回退：
 *   1. 本地文件 /characters/<卡名>/rw/<slug>.png
 *   2. 头像池   /characters/<卡名>/rw/pool/<n>.png   （按名字哈希取）
 *   3. 程序化 SVG
 * 用 <img onerror> 链实现。注意：扩展注入的 DOM 不经过 DOMPurify，
 * 所以这里可以安全使用 onerror。
 */
function avatarHTML(npc, cls, accentRing) {
    const look = { ...autoLook(npc.name), ...(npc.look || {}) };
    const ring = accentRing ?? npc.ring ?? '#ffd0e5';
    const svg = avatarSVG(look, cls);
    const slug = encodeURIComponent(String(npc.name || 'npc'));
    const charName = (() => { try { return C().characters?.[C().characterId]?.name ?? 'RadioWave'; } catch { return 'RadioWave'; } })();
    const local = `/characters/${encodeURIComponent(charName)}/rw/${slug}.png`;
    const poolIdx = hashStr(npc.name) % 12;
    const pool = `/characters/${encodeURIComponent(charName)}/rw/pool/${poolIdx}.png`;
    // <img> 依次尝试本地 → 池 → 隐藏自己露出 SVG
    return `<span class="rw_avbox" style="--ring:${ring}">
        <img class="${cls}" src="${local}" alt=""
             onerror="if(!this.dataset.s){this.dataset.s='1';this.src='${pool}';}else{this.style.display='none';this.nextElementSibling.style.display='block';}">
        <span style="display:none">${svg}</span>
    </span>`;
}

function avatarSVG(p, cls) {
    const g = 'rwg' + (_uid++), skin = '#ffe2d2';
    const back = {
        twintail: `<ellipse cx="50" cy="58" rx="29" ry="32" fill="${p.hair}"/>
                   <ellipse cx="17" cy="64" rx="10" ry="19" fill="${p.hair}"/><ellipse cx="83" cy="64" rx="10" ry="19" fill="${p.hair}"/>
                   <circle cx="17" cy="49" r="6.5" fill="${p.hair}"/><circle cx="83" cy="49" r="6.5" fill="${p.hair}"/>`,
        bob: `<ellipse cx="50" cy="56" rx="28" ry="30" fill="${p.hair}"/>`,
        short: `<ellipse cx="50" cy="54" rx="27" ry="27" fill="${p.hair}"/>`,
        long: `<path d="M18 52 Q18 20 50 20 Q82 20 82 52 L86 92 L70 88 L50 92 L30 88 L14 92 Z" fill="${p.hair}"/>`,
    }[p.hairStyle] || '';
    let acc = '';
    if (p.accessory === 'catear') {
        acc = `<path d="M24 26 L30 10 L40 23 Z" fill="#ff7ab8"/><path d="M76 26 L70 10 L60 23 Z" fill="#ff7ab8"/>
               <path d="M26.5 24 L30 15 L35.5 22 Z" fill="#ffd0e5"/><path d="M73.5 24 L70 15 L64.5 22 Z" fill="#ffd0e5"/>
               <circle cx="76" cy="27" r="6.5" fill="#ff3d8b"/><path d="M76 21 L70.5 27 L76 33 L81.5 27 Z" fill="#ff8fc0"/>`;
    } else if (p.accessory === 'phone') {
        acc = `<g transform="rotate(-14 76 74)"><rect x="68" y="62" width="17" height="26" rx="4.2" fill="#fff" stroke="#cfc4e6" stroke-width="1.6"/>
               <rect x="72" y="66" width="9" height="15" rx="1.6" fill="#e6dcff"/>
               <path d="M74 70 q2.5-2.4 5 0" stroke="#8b5cf6" stroke-width="1.2" fill="none" stroke-linecap="round"/></g>`;
    }
    return `<svg class="${cls}" viewBox="0 0 100 100" aria-hidden="true">
        <defs><linearGradient id="${g}" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#ffe6f3"/><stop offset="1" stop-color="#e6d9ff"/></linearGradient></defs>
        <circle cx="50" cy="50" r="50" fill="url(#${g})"/>
        ${back}
        <rect x="44" y="70" width="12" height="13" rx="5.5" fill="#f6cbb5"/>
        <ellipse cx="50" cy="52" rx="23.5" ry="26.5" fill="${skin}"/>
        <path d="M26.5 47 Q29 23 50 23 Q71 23 73.5 47 Q67 34 58.5 41.5 Q50 29 41.5 41.5 Q33 34 26.5 47 Z" fill="${p.hair}"/>
        <ellipse cx="40.2" cy="55" rx="4.9" ry="6.3" fill="${p.eye}"/><ellipse cx="59.8" cy="55" rx="4.9" ry="6.3" fill="${p.eye}"/>
        <circle cx="41.9" cy="52.4" r="1.9" fill="#fff" opacity=".92"/><circle cx="61.5" cy="52.4" r="1.9" fill="#fff" opacity=".92"/>
        <ellipse cx="34.5" cy="62.5" rx="4.8" ry="2.9" fill="#ff9ec4" opacity=".5"/><ellipse cx="65.5" cy="62.5" rx="4.8" ry="2.9" fill="#ff9ec4" opacity=".5"/>
        <path d="M47 65.5 Q50 69 53 65.5" stroke="#c2698e" stroke-width="1.6" fill="none" stroke-linecap="round"/>
        ${acc}
    </svg>`;
}

/* ============================================================
   四、世界书同步
   ============================================================ */

/** STscript 参数转义 */
function q(s) {
    return '"' + String(s ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\|/g, '\\|')
        .replace(/\{/g, '\\{')
        .replace(/\}/g, '\\}')
        .replace(/[\r\n]+/g, ' ')
        + '"';
}

async function runCmd(cmd) {
    const c = C();
    if (typeof c.executeSlashCommandsWithOptions !== 'function') {
        warn('executeSlashCommandsWithOptions 不可用，跳过世界书同步');
        return null;
    }
    try {
        const r = await c.executeSlashCommandsWithOptions(cmd, { showOutput: false });
        return typeof r === 'string' ? r : (r?.pipe ?? '');
    } catch (e) {
        warn('STscript 执行失败:', cmd.slice(0, 90), e);
        return null;
    }
}

let _bookName = null;
async function getChatBook() {
    if (_bookName) return _bookName;
    const r = await runCmd('/getchatbook');
    if (r === null) return null;
    _bookName = String(r).trim();
    return _bookName;
}

/** 电波 → 世界书条目。失效/删除都会同步。 */
async function syncWaveToLore(wave) {
    if (!getSettings().syncLorebook) return false;
    const book = await getChatBook();
    if (!book) return false;
    const key = `电波·${wave.name}`;
    const content = [
        `【生效中的电波】${wave.name}`,
        `内容：${wave.body}`,
        wave.scope ? `范围：${wave.scope}` : '',
        wave.target ? `对象：${wave.target}` : '',
        wave.dur ? `持续：${wave.dur}` : '',
        '（这条电波正在改写世界，其中的人会自然地合理化自己的改变，且不会察觉。）',
    ].filter(Boolean).join('\n');

    if (!wave.loreUid) {
        const uid = await runCmd(`/createentry file=${q(book)} key=${q(key)} ${q(content)}`);
        if (uid === null) return false;
        wave.loreUid = String(uid).trim();
    } else {
        const ok = await runCmd(`/setentryfield file=${q(book)} uid=${q(wave.loreUid)} field=content ${q(content)}`);
        if (ok === null) return false;
    }
    if (wave.loreUid) {
        await runCmd(`/setentryfield file=${q(book)} uid=${q(wave.loreUid)} field=constant 1`);
        await runCmd(`/setentryfield file=${q(book)} uid=${q(wave.loreUid)} field=disable ${wave.state === 'on' ? 0 : 1}`);
        wave.synced = true;
        return true;
    }
    return false;
}

async function unsyncWaveFromLore(wave) {
    if (!wave.loreUid) return;
    const book = await getChatBook();
    if (!book) return;
    // STscript 没有删除条目的命令，用「清空内容 + 禁用」实现软删除
    await runCmd(`/setentryfield file=${q(book)} uid=${q(wave.loreUid)} field=content ""`);
    await runCmd(`/setentryfield file=${q(book)} uid=${q(wave.loreUid)} field=disable 1`);
    wave.loreUid = null;
    wave.synced = false;
}

/* ---------- 设置 → 世界书 ----------
 * 设置必须让 AI 每轮都看到，否则开关只是个 UI 装饰。
 * 做法：在聊天绑定世界书里维护一条 constant 条目，开关一变就重写它。
 */
const SETTINGS_LORE_KEY = '电波运作模式';
const SETTINGS_LORE_TITLE = '【电波运作模式 —— 每轮必须遵守】';

function buildSettingsLoreContent(state) {
    const st = state.settings;
    return [
        SETTINGS_LORE_TITLE,
        st.rationalize
            ? '合理化改写：**开启**。被电波改写的人会把新的观念当成天经地义的常识——就像没有人会质疑「为什么人有两只手」。他们不会察觉、不会怀疑、不会反抗，并且能立刻为这个新观念给出完全合理的解释。'
            : '合理化改写：**关闭**。电波只控制身体行动，不触及意识。被改写者的身体会照做，但意识完全清醒：他们会困惑、恐惧、试图拒绝，只是身体不听使唤。写完效果后必须描写这种身心撕裂。',
        st.syncResist
            ? '同步者抵抗：**开启**。同步者受到电波时效果减半（强度或持续时间减半），并且会感到明显的、说不清的强烈不适。'
            : '同步者抵抗：**关闭**。同步者与常人一样被完全改写。',
        st.onlyFemale ? '档案只记录女性角色；不要为男性角色输出档案字段。' : '',
        '视角纪律：除主角外，任何角色都不知道「电波」的存在，也不该有任何上帝视角。每个角色只掌握自己亲眼所见、亲耳所闻的信息。',
    ].filter(Boolean).join('\n');
}

async function syncSettingsToLore(state) {
    if (!getSettings().syncLorebook) return false;
    const book = await getChatBook();
    if (!book) return false;
    const content = buildSettingsLoreContent(state);
    if (!state.settingsLoreUid) {
        const uid = await runCmd(`/createentry file=${q(book)} key=${q(SETTINGS_LORE_KEY)} ${q(content)}`);
        if (uid === null) return false;
        state.settingsLoreUid = String(uid).trim();
    } else {
        const ok = await runCmd(`/setentryfield file=${q(book)} uid=${q(state.settingsLoreUid)} field=content ${q(content)}`);
        if (ok === null) return false;
    }
    if (state.settingsLoreUid) {
        await runCmd(`/setentryfield file=${q(book)} uid=${q(state.settingsLoreUid)} field=constant 1`);
        await runCmd(`/setentryfield file=${q(book)} uid=${q(state.settingsLoreUid)} field=disable 0`);
        return true;
    }
    return false;
}

/* ---------- 地图方位 → 世界书 ----------
 * 玩家能拖动地点，AI 也得知道方位。所以把坐标写进世界书。
 * 按父级拆成多条，且**不是常驻**——只在对话里提到该地点时才注入，省 token。
 */
const MAP_LORE_PREFIX = '方位图·';

function mapLoreKey(parent, locs) {
    return MAP_LORE_PREFIX + (parent === 'city' ? '临江市' : (locs[parent]?.name || parent));
}

function buildMapLoreContent(state, parent) {
    const locs = getLocs();
    const children = Object.entries(locs)
        .filter(([, l]) => (l.parent || 'city') === parent)
        .sort((a, b) => (a[1].y ?? 0) - (b[1].y ?? 0) || (a[1].x ?? 0) - (b[1].x ?? 0));

    const title = parent === 'city' ? '临江市 · 大地图' : `${locs[parent]?.name ?? parent} · 内部`;
    const lines = [
        `【方位图 · ${title}】`,
        '坐标是百分比，(x, y) = (横向, 纵向)，左上角为原点。x 越大越靠东，y 越大越靠南。两点坐标越接近，步行距离越短。',
        '',
    ];
    for (const [, l] of children) {
        lines.push(`· ${l.name} (${Math.round(l.x)}, ${Math.round(l.y)})${l.desc ? ' —— ' + l.desc : ''}`);
    }
    if (parent === 'city') {
        lines.push('');
        lines.push('方位规则：临江自北向南穿城，把城市分成两岸。西岸（x < 50）是老城区，市立三中与立德大学都在这一侧，大学在三中的东南方，两校步行约十分钟。东岸（x > 50）是新城区，警局在北、写字楼在南。连接两岸只有两座桥：上游的临江大桥（走车，早高峰堵死）、下游的老铁桥（只走人和电动车）。');
    }
    return lines.join('\n');
}

async function syncMapToLore(state) {
    if (!getSettings().syncLorebook) return false;
    const book = await getChatBook();
    if (!book) return false;
    const locs = getLocs();
    const parents = [...new Set(Object.values(locs).map(l => l.parent || 'city'))];

    state.mapLoreUids = state.mapLoreUids || {};
    let ok = 0;
    for (const parent of parents) {
        const content = buildMapLoreContent(state, parent);
        const key = mapLoreKey(parent, locs);
        // 关键字：该组下所有地点的名字与别名，让条目只在提到这些地方时注入
        const keys = Object.entries(locs)
            .filter(([, l]) => (l.parent || 'city') === parent)
            .flatMap(([, l]) => [l.name, ...(Array.isArray(l.match) ? l.match : [])])
            .filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);

        const uid = state.mapLoreUids[parent];
        if (!uid) {
            const r = await runCmd(`/createentry file=${q(book)} key=${q(key)} ${q(content)}`);
            if (r === null) continue;
            state.mapLoreUids[parent] = String(r).trim();
        } else {
            const r = await runCmd(`/setentryfield file=${q(book)} uid=${q(uid)} field=content ${q(content)}`);
            if (r === null) continue;
        }
        const u = state.mapLoreUids[parent];
        if (!u) continue;
        await runCmd(`/setentryfield file=${q(book)} uid=${q(u)} field=key ${q(keys.join(','))}`);
        await runCmd(`/setentryfield file=${q(book)} uid=${q(u)} field=constant 0`);
        await runCmd(`/setentryfield file=${q(book)} uid=${q(u)} field=disable 0`);
        ok++;
    }
    return ok > 0;
}

/* ============================================================
   五、状态提取
   ============================================================ */

/** 宽松 JSON 解析：容忍 ```json 包裹、尾逗号、单引号 */
function parseLooseJSON(text) {
    if (!text) return null;
    let t = String(text).trim();
    t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    try { return JSON.parse(t); } catch { /* 继续 */ }
    // 去掉尾逗号
    let t2 = t.replace(/,(\s*[}\]])/g, '$1');
    try { return JSON.parse(t2); } catch { /* 继续 */ }
    // 截取第一个 { 到最后一个 }
    const a = t2.indexOf('{'), b = t2.lastIndexOf('}');
    if (a >= 0 && b > a) {
        try { return JSON.parse(t2.slice(a, b + 1)); } catch { /* 继续 */ }
    }
    return null;
}

const STATE_SCHEMA = {
    name: 'RadioWaveState',
    description: '从最近的对话中提取主角状态、人物档案变化与电波变化',
    strict: false,
    value: {
        type: 'object',
        properties: {
            player: {
                type: 'object',
                properties: {
                    place: { type: 'string', description: '当前所在地点 id，可选：home/school/police/diner/office/teach/canteen/dorm/field/lib' },
                    placeText: { type: 'string', description: '当前地点的中文描述' },
                    outfit: { type: 'string', description: '主角当前穿搭，用完整中文描述' },
                    note: { type: 'string' },
                },
            },
            npc: {
                type: 'array',
                description: '本次交互中出场或被提及的人物。已存在的人物只填发生变化的字段。',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        title: { type: 'string', description: '身份称号，如「青梅竹马」' },
                        tags: { type: 'array', items: { type: 'string' }, description: '2-4 个性格标签' },
                        aff: { type: 'number', description: '好感度 0-100' },
                        heart: { type: 'string', description: '喜欢的人' },
                        inner: { type: 'string', description: '当前心声，第一人称，一句到两句' },
                        doing: { type: 'string', description: '当前行为' },
                        place: { type: 'string', description: '当前所在地的中文描述' },
                        loc: { type: 'string', description: '当前所在地点 id' },
                        personality: { type: 'string', description: '客观性格评语，50-120 字，不随剧情变化' },
                        wear: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: '穿搭，形如 [["发型","..."],["上装","..."]]' },
                    },
                    required: ['name'],
                },
            },
            wave: {
                type: 'array',
                description: '本次交互中新增或被改动的电波',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        body: { type: 'string', description: '电波内容' },
                        scope: { type: 'string', description: '生效范围' },
                        target: { type: 'string', description: '影响对象' },
                        start: { type: 'string' },
                        dur: { type: 'string', description: '持续时间' },
                        state: { type: 'string', enum: ['on', 'pending', 'expired'] },
                    },
                    required: ['name'],
                },
            },
        },
    },
};

const QUIET_PROMPT = `你是状态提取器。阅读最近的对话，提取【主角状态】、【人物档案】、【电波】三类的变化，只输出 JSON。

规则：
- 没有变化的部分不要输出。
- 人物：只输出本轮出场或被提及的人。已存在于档案的人只填发生变化的字段；新出现的人尽量填全（name/title/tags/aff/inner/doing/place/loc/personality/wear）。
- aff 是好感度 0-100 的整数。inner 是这个人此刻心里的第一人称独白。personality 是客观性格评语（50-120字），描述这个人的稳定人格，不写剧情。
- 穿搭 wear 用 [[部位, 描述]] 的数组，部位如 发型/脸型/上装/下装/内衣/配饰。
- 电波：玩家发射的新电波，或已有电波的状态变化（on=生效中 / pending=未发射 / expired=已失效）。
- 不要输出任何解释文字。`;

/* ---------- 电波名去重 ----------
 * AI 每轮会用不同措辞复述同一条电波（用户建的是「让周砚忘掉线索」，
 * AI 报的是「忘掉线索」）。精确匹配会把它们当成两条。
 * 这里做三级匹配：规范化全等 → 互相包含 → 二元组 Dice 相似度。
 */
const NAME_NOISE = /[「」『』《》〈〉“”‘’"'·・、,，.。!！?？:：;；\s\-—_~～()（）\[\]【】]/g;

function normName(s) {
    return String(s ?? '').replace(NAME_NOISE, '').toLowerCase();
}

function bigrams(s) {
    const out = new Set();
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    return out;
}

function diceSim(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    const A = bigrams(a), B = bigrams(b);
    let inter = 0;
    for (const g of A) if (B.has(g)) inter++;
    return (2 * inter) / (A.size + B.size);
}

const WAVE_SIM_THRESHOLD = 0.7;

/** 在已有电波里找 item 对应的那条，找不到返回 -1 */
function findWaveIndex(waves, name) {
    const n = normName(name);
    if (!n) return -1;
    let i = waves.findIndex(w => normName(w.name) === n);
    if (i > -1) return i;
    if (n.length >= 2) {
        i = waves.findIndex(w => {
            const o = normName(w.name);
            return o.length >= 2 && (o.includes(n) || n.includes(o));
        });
        if (i > -1) return i;
    }
    let best = -1, bestScore = WAVE_SIM_THRESHOLD;
    waves.forEach((w, idx) => {
        const s = diceSim(normName(w.name), n);
        if (s > bestScore) { bestScore = s; best = idx; }
    });
    return best;
}

/** 把整份电波列表内部的重复项合并掉（兜底用），返回合并掉的条数 */
function dedupeWaves(waves) {
    const kept = [];
    let merged = 0;
    for (const w of waves) {
        const idx = findWaveIndex(kept, w.name);
        if (idx === -1) { kept.push(w); continue; }
        // 合并：保留已存在的 loreUid，用非空字段补齐
        const t = kept[idx];
        for (const k of ['body', 'scope', 'target', 'start', 'dur', 'name']) {
            if (!t[k] && w[k]) t[k] = w[k];
        }
        if (w.state && !t.state) t.state = w.state;
        if (!t.loreUid && w.loreUid) t.loreUid = w.loreUid;
        t.synced = false;
        merged++;
    }
    waves.length = 0;
    waves.push(...kept);
    return merged;
}

function applyStatePayload(state, payload) {
    if (!payload || typeof payload !== 'object') return 0;
    let n = 0;
    const locs = getLocs();

    if (payload.player && typeof payload.player === 'object') {
        for (const k of ['place', 'placeText', 'outfit', 'note', 'title', 'identity', 'age']) {
            if (payload.player[k] !== undefined && payload.player[k] !== null && payload.player[k] !== '') {
                state.player[k] = payload.player[k]; n++;
            }
        }
    }

    for (const src of [payload.npc, payload.npcs, payload.characters]) {
        if (!Array.isArray(src)) continue;
        for (const item of src) {
            if (!item?.name) continue;
            const nm = String(item.name).trim();

            // 只收录女性角色：只在「明确是男性」时拒绝，未知一律放行
            if (state.settings.onlyFemale && genderOf(item.gender) === 'male') continue;

            let t = state.npcs.find(x => x.name === nm);
            if (!t) {
                t = { name: nm, aff: 0, tags: [], isNew: true, gender: 'female', isSyncer: false, hidden: false, ...emptyRegions() };
                state.npcs.push(t);
            }
            migrateNpc(t);

            // 已隐藏的角色不再更新状态
            if (t.hidden) continue;

            for (const k of ['title', 'heart', 'inner', 'doing', 'place', 'loc', 'ring', 'accent', 'look', 'gender']) {
                if (item[k] !== undefined && item[k] !== null && item[k] !== '') { t[k] = item[k]; n++; }
            }
            if (typeof item.isSyncer === 'boolean') { t.isSyncer = item.isSyncer; n++; }
            if (Array.isArray(item.tags) && item.tags.length) {
                t.tags = item.tags.slice(0, 6).map(x => String(x)); n++;
            }

            // ---- 四大区域 ----
            for (const r of NPC_REGIONS) {
                const sub = item[r.key];
                if (!sub || typeof sub !== 'object') continue;
                if (r.kind === 'exp') {
                    if (sub.count !== undefined && !Number.isNaN(Number(sub.count))) {
                        t.exp.count = Math.max(0, Math.round(Number(sub.count))); n++;
                    }
                    if (typeof sub.virgin === 'boolean') { t.exp.virgin = sub.virgin; n++; }
                    if (sub.kinks) { t.exp.kinks = String(sub.kinks); n++; }
                    continue;
                }
                for (const [f] of r.fields) {
                    const v = sub[f];
                    if (v === undefined || v === null) continue;
                    if (r.typed) {
                        const desc = (v && typeof v === 'object') ? v.desc : v;
                        const type = (v && typeof v === 'object') ? v.type : '';
                        if (desc) { t[r.key][f].desc = String(desc); n++; }
                        if (type) { t[r.key][f].type = String(type); n++; }
                    } else if (v !== '') {
                        t[r.key][f] = String(v); n++;
                    }
                }
            }

            // 兼容 AI 偶尔仍用旧字段
            if (Array.isArray(item.wear) && item.wear.length) { t.wear = item.wear; migrateNpc(t); n++; }
            if (item.personality && !t.feature.qizhi) { t.feature.qizhi = String(item.personality); n++; }

            if (item.aff !== undefined && !Number.isNaN(Number(item.aff))) {
                const v = Math.max(0, Math.min(100, Math.round(Number(item.aff))));
                if (t.aff !== v) { t.aff = v; n++; }
            }
            // 没给 loc 就试着从 place 文本里推断
            if (!t.loc && t.place) t.loc = inferLoc(locs, t.place);
        }
    }

    for (const src of [payload.wave, payload.waves]) {
        if (!Array.isArray(src)) continue;
        for (const item of src) {
            if (!item?.name) continue;
            const idx = findWaveIndex(state.waves, item.name);
            let w;
            if (idx === -1) {
                w = { id: Date.now() + Math.floor(Math.random() * 1000), name: item.name.trim(), state: 'on', synced: false, loreUid: null, origin: 'ai' };
                state.waves.push(w);
            } else {
                w = state.waves[idx];
                // 合并命中的是 AI 复述，保留原有名字更稳定，除非原来没名字
                if (!w.name) w.name = item.name.trim();
            }
            for (const k of ['body', 'scope', 'target', 'start', 'dur']) {
                if (item[k] !== undefined && item[k] !== null && item[k] !== '') { w[k] = item[k]; n++; }
            }
            if (item.state && ['on', 'pending', 'expired'].includes(item.state)) { w.state = item.state; n++; }
            // 内容变过就得重新同步世界书
            w.synced = false;
        }
    }
    return n;
}

/**
 * 从一段中文地点描述里推断地点 id。
 *
 * 难点：「立德大学的图书馆」既命中 univ 也命中 lib（三中的），
 * 单纯按深度取最深会错判成三中的图书馆。
 * 所以分三步：① 先认出文中提到的**顶层地点** ② 在该顶层地点内部找子地点（先比别名，再比名字）
 * ③ 没有顶层命中时，才退回「取最深」。
 */
function inferLoc(locs, text) {
    if (!text) return undefined;

    const depth = id => {
        let d = 0, cur = locs[id];
        while (cur?.parent && locs[cur.parent]) { d++; cur = locs[cur.parent]; }
        return d;
    };
    const parentOf = id => locs[id]?.parent || 'city';
    const keysOf = id => {
        const l = locs[id] || {};
        return (Array.isArray(l.match) ? l.match : []).concat([l.name]).filter(Boolean);
    };
    /** 命中的别名里最长的那个 —— 越长越具体 */
    const spec = id => Math.max(0, ...keysOf(id).filter(k => text.includes(k)).map(k => k.length));

    const matches = Object.keys(locs).filter(id => keysOf(id).some(k => text.includes(k)));
    if (!matches.length) return undefined;

    // ① 顶层地点（parent 是 city）
    const tops = matches.filter(id => parentOf(id) === 'city');
    if (tops.length) {
        const top = tops.reduce((a, b) => (spec(b) > spec(a) ? b : a));
        // ② 该顶层地点内部的子地点
        const kids = matches.filter(id => parentOf(id) === top);
        if (kids.length) return kids.sort((a, b) => depth(b) - depth(a))[0];
        // 子地点的别名没命中，但顶层被提到了 —— 试着用子地点的「名字」直接匹配
        const byName = Object.keys(locs).filter(id => parentOf(id) === top && text.includes(locs[id].name));
        if (byName.length) return byName[0];
        return top;
    }

    // ③ 没有提到任何顶层地点，取最深的
    return matches.sort((a, b) => depth(b) - depth(a))[0];
}

function extractFromMessage(text) {
    const m = STATE_BLOCK_RE.exec(String(text ?? ''));
    if (!m) return null;
    return parseLooseJSON(m[1]);
}

/* ============================================================
   六、UI 渲染
   ============================================================ */

/* 统一用原生 DOM，避免和酒馆的全局 jQuery($) 混用 */
const $q = (sel, root = document) => root.querySelector(sel);
const $qa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * 档案数据里的 {{user}} 必须换成当前 persona 名再显示。
 * 扩展是直接渲染 HTML 的，不走酒馆的宏替换——不处理的话页面上会原样出现 "{{user}}"。
 */
function subUser(s) {
    let name = '';
    try { name = C().name1 || ''; } catch { /* ignore */ }
    if (!name) name = '你';
    return String(s ?? '').replace(/\{\{\s*user\s*\}\}/gi, name);
}
/** 先替换 {{user}} 再转义 */
const escU = s => esc(subUser(s));
const WAVE_STL = { on: '生效中', expired: '已失效', pending: '未发射' };

let $overlay = null, $panel = null, $modal = null;

const NAV_ITEMS = ['home', 'roster', 'wave', 'map', 'settings'];

function buildShell() {
    if ($q('#rw_launcher')) {
        // 结构过时就拆掉重建（比如旧版本只有 4 个导航项，缺「设置」）
        const have = $qa('#rw_nav .sa-nb').length;
        if (have === NAV_ITEMS.length) return;
        warn(`检测到过期的面板外壳（导航项 ${have}/${NAV_ITEMS.length}），正在重建`);
        $q('#rw_launcher')?.remove();
        $q('#rw_overlay')?.remove();
        $q('#rw_modal')?.remove();
    }
    document.body.insertAdjacentHTML('beforeend', `
        <button id="rw_launcher" title="无意识电波 · App">
            <svg viewBox="0 0 24 24"><path d="M12 5.5v13"/><path d="M8 8.5a5 5 0 0 0 0 7"/><path d="M16 8.5a5 5 0 0 1 0 7"/>
            <path d="M5 6a8.5 8.5 0 0 0 0 12"/><path d="M19 6a8.5 8.5 0 0 1 0 12"/></svg>
        </button>
        <div id="rw_overlay">
            <div id="rw_panel">
                <div class="sa-phone">
                    <div class="sa-glow"></div><div class="sa-glow b"></div>
                    <div class="sa-status">
                        <span id="rw_clock">08:32</span>
                        <span class="sa-right">
                            <span class="sa-sig"><i></i><i></i><i></i><i></i></span>
                            <svg width="15" height="12" viewBox="0 0 15 12" fill="none">
                                <path d="M1 4.1a9.6 9.6 0 0 1 13 0" stroke="#3a3153" stroke-width="1.6" stroke-linecap="round"/>
                                <path d="M3.6 6.9a5.9 5.9 0 0 1 7.8 0" stroke="#3a3153" stroke-width="1.6" stroke-linecap="round"/>
                                <circle cx="7.5" cy="10" r="1.25" fill="#3a3153"/></svg>
                            <span class="sa-batt"><b></b></span>
                            <button class="sa-close" id="rw_close">✕</button>
                        </span>
                    </div>
                    <div class="sa-body" id="rw_body"></div>
                    <aside class="sa-sb" id="rw_sb">
                        <div class="sa-sbh"><span class="sa-sbn" id="rw_sbn">地点</span>
                            <button class="sa-sbx" id="rw_sbx">✕</button></div>
                        <div class="sa-sbb" id="rw_sbb"></div>
                    </aside>
                    <nav class="sa-nav" id="rw_nav">
                        <button class="sa-nb" data-go="home"><svg viewBox="0 0 24 24"><path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V20h13V9.5"/></svg>主页</button>
                        <button class="sa-nb" data-go="roster"><svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2"/><path d="M3.2 20c0-3.4 2.6-5.6 5.8-5.6s5.8 2.2 5.8 5.6"/><path d="M16.5 5.6a3 3 0 0 1 0 5.6"/><path d="M18 14.8c2 .6 3.3 2.2 3.3 4.4"/></svg>档案</button>
                        <button class="sa-nb" data-go="wave"><svg viewBox="0 0 24 24"><path d="M12 5.5v13"/><path d="M8 8.5a5 5 0 0 0 0 7"/><path d="M16 8.5a5 5 0 0 1 0 7"/><path d="M5 6a8.5 8.5 0 0 0 0 12"/><path d="M19 6a8.5 8.5 0 0 1 0 12"/></svg>电波</button>
                        <button class="sa-nb" data-go="map"><svg viewBox="0 0 24 24"><path d="M3.5 6.5 9 4.5l6 2 5.5-2v13L15 19.5l-6-2-5.5 2z"/><path d="M9 4.5v13M15 6.5v13"/></svg>地图</button>
                        <button class="sa-nb" data-go="settings"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6 7.7 7.7M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/></svg>设置</button>
                    </nav>
                    <div class="sa-dock" style="position:absolute;bottom:13px;left:50%;transform:translateX(-50%);height:3.5px;width:110px;border-radius:99px;background:#ded6ea"></div>
                </div>
            </div>
        </div>
        <div id="rw_modal"><div class="rw_box" id="rw_box"></div></div>
    `);
    $overlay = $q('#rw_overlay');
    $panel = $q('#rw_panel');
    $modal = $q('#rw_modal');

    $q('#rw_launcher').addEventListener('click', openPanel);
    $q('#rw_close').addEventListener('click', closePanel);
    $overlay.addEventListener('click', e => { if (e.target === $overlay) closePanel(); });
    $q('#rw_sbx').addEventListener('click', closeSb);
    $q('#rw_nav').addEventListener('click', e => {
        const b = e.target.closest('[data-go]'); if (!b) return;
        const s = getState(); s.ui.page = b.dataset.go; saveState(); renderPage();
    });
    // 绑在整个面板上 —— 侧边栏 #rw_sb 是 #rw_body 的兄弟节点，
    // 以前只绑 #rw_body 导致侧边栏里所有点击（人物、进入平面图）都失效。
    $q('#rw_panel').addEventListener('click', onBodyClick);
    $q('#rw_box').addEventListener('click', onModalClick);
}

function openPanel() {
    buildShell();
    ensureSeeded();
    const s = getState();
    $q('#rw_clock').textContent = s.time || '08:32';
    $overlay.classList.add('rw_on');
    closeSb();
    renderPage();
}
function closePanel() { $overlay?.classList.remove('rw_on'); closeSb(); }

function closeSb() { $q('#rw_sb')?.classList.remove('on'); }

function renderPage() {
    const s = getState();
    const page = s.ui.page || 'home';
    const body = $q('#rw_body');
    $q('#rw_clock').textContent = s.time || '08:32';
    for (const b of $qa('#rw_nav .sa-nb')) b.classList.toggle('on', b.dataset.go === page);
    if (page === 'home') body.innerHTML = viewHome(s);
    else if (page === 'roster') body.innerHTML = viewRoster(s);
    else if (page === 'detail') body.innerHTML = viewDetail(s);
    else if (page === 'wave') body.innerHTML = viewWave(s);
    else if (page === 'map') body.innerHTML = viewMap(s);
    else if (page === 'settings') body.innerHTML = viewSettings(s);
    // 地图编辑模式下给地点绑拖动
    if (page === 'map') {
        for (const el of $qa('#rw_body [data-drag]')) {
            el.addEventListener('pointerdown', ev => onPinPointerDown(ev, el.dataset.drag));
        }
    }
    body.scrollTop = 0;
}

/* ---------- 主页 ---------- */
function viewHome(s) {
    const locs = getLocs();
    const live = s.waves.filter(w => w.state === 'on').length;
    const last = s.waves[s.waves.length - 1];
    return `
    <div class="sa-head">
        <div><h1 class="sa-title">无意识电波</h1>
        <p class="sa-sub">第 ${esc(s.day)} 天 · ${esc(s.time)}</p></div>
        <button class="sa-ghost" data-act="edit-player">编辑</button>
    </div>
    <div class="sa-hero"><div class="sa-hrow">
        <div>${avatarHTML({ name: s.player.name || '我', look: { hair: '#4a4258', hairStyle: 'bob', eye: '#3d3550', accessory: 'phone' }, ring: '#ffd0e5' }, 'sa-hav')}</div>
        <div>
            <div class="sa-hname">${esc(s.player.name || '（未命名）')}</div>
            <div class="sa-hmeta">
                <span class="sa-badge">${esc(s.player.title || '电波持有者')}</span>
                ${s.player.identity ? `<span class="sa-badge v">${esc(s.player.identity)}</span>` : ''}
            </div>
            <div class="sa-age">${esc(s.player.age)} 岁${s.player.sub ? ' · ' + esc(s.player.sub) : ''}</div>
        </div>
    </div></div>
    <div class="sa-block"><div class="sa-lbl">📍 当前地点</div>
        <p class="sa-txt" style="font-weight:800;color:#4a4166">${esc(s.player.placeText || locLabel(locs, s.player.place))}</p></div>
    <div class="sa-block"><div class="sa-lbl">👕 当前穿搭
        <span style="margin-left:auto;font-size:9px;color:#c9c2d8">随互动刷新</span></div>
        <p class="sa-txt">${esc(s.player.outfit || '（待记录）')}</p></div>
    <div class="sa-stats">
        <div class="sa-stat"><b style="color:#8b5cf6">${live}</b><span>生效中电波</span></div>
        <div class="sa-stat"><b style="color:#ff3d8b">${s.npcs.length}</b><span>已记录人物</span></div>
        <div class="sa-stat"><b style="color:#0ea5e9">${s.knownLocs.length}</b><span>已解锁地点</span></div>
    </div>
    ${last ? `<div class="sa-block"><div class="sa-lbl">⚡ 最近一次电波</div>
        <p class="sa-txt"><b style="color:#4a4166">「${esc(last.name)}」</b> · ${esc(last.scope || '—')}<br>${esc(last.body || '')}</p></div>` : ''}
    ${s.player.note ? `<div class="sa-block"><div class="sa-lbl">✎ 备注</div><p class="sa-txt">${esc(s.player.note)}</p></div>` : ''}
    ${!s.npcs.length ? `<div class="sa-block" style="background:#fff9f2;border-color:#ffe3c8">
        <div class="sa-lbl" style="color:#c9852f">⚠ 档案还是空的</div>
        <p class="sa-txt">没有读到角色卡里的初始档案。可能是角色数据还没加载完，
        也可能是浏览器跑的还是旧版扩展。先点下面的按钮重试；不行就看控制台
        <b style="color:#c9852f">[无意识电波]</b> 开头的黄色诊断行。</p>
        <div class="sa-wacts" style="margin-top:10px">
            <button class="sa-mini go" data-act="reseed">↻ 重新读取卡内档案</button>
        </div></div>` : ''}
    <div style="text-align:center;font-size:10px;color:#c9c2d8;font-weight:700;margin:14px 0 6px">
        无意识电波 App 前端 v${EXT_VERSION}
    </div>`;
}

/* ---------- 档案 ---------- */
/** 档案列表里的一张人物卡 */
function npcCard(n, realIdx, hiddenView) {
    const accent = n.accent || '#ff3d8b';
    return `<div class="sa-card${n.isNew && !hiddenView ? ' new' : ''}${hiddenView ? ' dimmed' : ''}" data-npc="${realIdx}">
        <div class="sa-avw">${avatarHTML(n, 'sa-av')}${n.isNew && !hiddenView ? '<span class="sa-new">NEW</span>' : ''}</div>
        <div class="sa-main">
            <div class="sa-nrow"><span class="sa-name">${esc(n.name)}</span>
                ${n.title ? `<span class="sa-badge">${esc(n.title)}</span>` : ''}</div>
            ${(n.tags || []).length ? `<div class="sa-tags">${n.tags.map(t => `<span class="sa-tag">${escU(t)}</span>`).join('')}</div>` : ''}
            <div class="sa-aff">
                <div class="sa-affbar"><div class="sa-afffill" style="width:${n.aff ?? 0}%;background:linear-gradient(90deg,${accent}99,${accent})"></div></div>
                <span class="sa-affnum" style="color:${accent}">${n.aff ?? 0}</span>
            </div>
        </div>
    </div>`;
}

function viewRoster(s) {
    const vis = visibleNpcs(s);
    const hid = hiddenNpcs(s);
    const showingHidden = !!s.ui.showHidden;
    const list = showingHidden ? hid : vis;

    const hiddenEntry = hid.length ? `
        <div class="sa-hiddenentry" data-act="toggle-hidden">
            <span>🙈 隐藏角色 <b>${hid.length}</b></span>
            <span class="sa-hint">${showingHidden ? '‹ 返回档案' : '查看 ›'}</span>
        </div>` : '';

    if (showingHidden) {
        return `
        <div class="sa-head">
            <div><h1 class="sa-title" style="font-size:22px">隐藏角色</h1>
            <p class="sa-sub">${hid.length} 人 · 状态已冻结，地图上不显示</p></div>
            <button class="sa-ghost" data-act="toggle-hidden">‹ 返回</button>
        </div>
        <div class="sa-list">${list.map(n => npcCard(n, s.npcs.indexOf(n), true)).join('')}</div>
        <div class="sa-slot">隐藏中的角色<b style="color:#8b5cf6">不会被 AI 更新状态</b>，也不会出现在地图红点里。<br>点开任意一位，可以在详情页把它移出隐藏。</div>`;
    }

    if (!vis.length && !hid.length) {
        return `<div class="sa-head"><div><h1 class="sa-title">档案</h1>
            <p class="sa-sub">还没有记录任何人</p></div></div>
            <div class="sa-slot" style="margin-top:20px">还没有遇见任何人。<br>去<b style="color:#8b5cf6">地图</b>上走走，或者直接开始对话 —— 档案会自己长出来。</div>`;
    }

    return `
    <div class="sa-head">
        <div><h1 class="sa-title">档案</h1>
        <p class="sa-sub">已记录 ${vis.length} 人${hid.length ? ` · 另隐藏 ${hid.length} 人` : ''}</p></div>
        <button class="sa-ghost" data-act="add-npc">＋ 手动</button>
    </div>
    <div class="sa-list">${list.map(n => npcCard(n, s.npcs.indexOf(n), false)).join('')}</div>
    <div class="sa-slot">这个世界还有 <span>?</span> 人你没见过 —— 他们会在你走动时自己出现</div>
    ${hiddenEntry}`;
}

/* ---------- 人物详情 ---------- */
/** 同步者标签 —— 两态都明确显示 */
function syncerBadge(n) {
    return n.isSyncer
        ? '<span class="sa-syncer yes">同步者</span>'
        : '<span class="sa-syncer no">非同步者</span>';
}

/** 渲染一个档案区域块（四大区域通用） */
function regionBlock(n, r) {
    if (r.kind === 'exp') {
        const e = n.exp || {};
        const rows = `
            <div class="sa-expgrid">
                <div class="sa-expcell"><span>性交次数</span><b>${esc(e.count ?? 0)}</b></div>
                <div class="sa-expcell"><span>是否为处女</span><b>${e.virgin ? '是' : '否'}</b></div>
            </div>
            ${e.kinks ? `<div class="sa-wrow" style="margin-top:11px">
                <span class="sa-wk">性癖</span><span class="sa-wv">${escU(e.kinks)}</span></div>` : ''}`;
        return `<div class="sa-fold${r.collapsed ? '' : ' open'}">
            <div class="sa-foldh" data-act="fold"><span class="sa-vbar"></span>
                <h4>${esc(r.label)}</h4><span class="sa-caret">⌄</span></div>
            <div class="sa-foldb">${rows}</div></div>`;
    }

    const items = r.fields.map(([f, label]) => {
        const v = (n[r.key] || {})[f];
        if (r.typed) {
            const desc = (v && typeof v === 'object') ? (v.desc || '') : '';
            const type = (v && typeof v === 'object') ? (v.type || '') : '';
            if (!desc && !type) return '';
            return `<div class="sa-bdrow">
                <div class="sa-bdhead"><span class="sa-bdk">${esc(label)}</span>
                    ${type ? `<span class="sa-bdtag">${escU(type)}</span>` : ''}</div>
                ${desc ? `<p class="sa-bdd">${escU(desc)}</p>` : ''}</div>`;
        }
        if (!v) return '';
        return `<div class="sa-wrow"><span class="sa-wk wide">${esc(label)}</span>
            <span class="sa-wv">${escU(v)}</span></div>`;
    }).filter(Boolean).join('');

    if (!items) return '';
    return `<div class="sa-fold${r.collapsed ? '' : ' open'}">
        <div class="sa-foldh" data-act="fold"><span class="sa-vbar"></span>
            <h4>${esc(r.label)}</h4><span class="sa-caret">⌄</span></div>
        <div class="sa-foldb"><div class="${r.typed ? 'sa-bdwrap' : 'sa-wear'}">${items}</div></div></div>`;
}

function viewDetail(s) {
    const i = s.ui.detailIndex ?? 0;
    const n = s.npcs[i];
    if (!n) return viewRoster(s);
    migrateNpc(n);
    const accent = n.accent || '#ff3d8b';
    const regions = NPC_REGIONS.map(r => regionBlock(n, r)).join('');
    return `
    <div class="sa-dhead">
        <div class="sa-dtop">
            <div>${avatarHTML(n, 'sa-dav')}</div>
            <div>
                <div class="sa-nrow">
                    <span class="sa-name" style="font-size:21px">${esc(n.name)}</span>
                    ${syncerBadge(n)}
                </div>
                ${n.title ? `<div style="margin-top:7px"><span class="sa-badge">${esc(n.title)}</span></div>` : ''}
            </div>
            <button class="sa-x" data-act="back-roster">✕</button>
        </div>
        <div class="sa-aff" style="margin-top:15px">
            <div class="sa-affbar" style="height:9px"><div class="sa-afffill" style="width:${n.aff ?? 0}%;background:linear-gradient(90deg,${accent}99,${accent})"></div></div>
            <span class="sa-affnum" style="color:${accent};font-size:16px">${n.aff ?? 0}</span>
        </div>
    </div>
    <div class="sa-block"><div class="sa-lbl">♥ 喜欢的人</div>
        <p class="sa-txt" style="font-weight:800;color:${accent}">${escU(n.heart || '尚未明确')}</p>
        ${(n.tags || []).length ? `<div class="sa-tags" style="margin-top:10px">${n.tags.map(t => `<span class="sa-tag">${escU(t)}</span>`).join('')}</div>` : ''}</div>
    <div class="sa-inner"><div class="sa-lbl">◌ 当前心声
        <span style="margin-left:auto;font-size:9px;color:#b8a8e0">随互动刷新</span></div>
        <p>“${escU(n.inner || '（尚未捕捉到）')}”</p></div>
    <div class="sa-block"><div class="sa-lbl">▶ 当前行为</div><p class="sa-txt">${escU(n.doing || '（未知）')}</p></div>
    <div class="sa-block"><div class="sa-lbl">📍 当前所在地</div>
        <p class="sa-txt" style="font-weight:800;color:#4a4166">${escU(n.place || '（未知）')}</p></div>
    ${regions || '<div class="sa-slot">这个人的档案区域还没有内容</div>'}
    ${n.hidden ? `<div class="sa-block" style="background:#f7f5fb;border-color:#e8e2f2">
        <div class="sa-lbl" style="color:#9a93ad">🙈 此角色已隐藏</div>
        <p class="sa-txt">她的状态已冻结，不会再被 AI 更新，也不会出现在地图上。点下面的「移出隐藏」可以恢复。</p></div>` : ''}
    <div class="sa-wacts" style="margin:11px 0 10px">
        <button class="sa-mini go" data-act="edit-npc" data-i="${i}">✎ 编辑档案</button>
        <button class="sa-mini" data-act="toggle-hide-npc" data-i="${i}">${n.hidden ? '👁 移出隐藏' : '🙈 隐藏'}</button>
        <button class="sa-mini dg" data-act="del-npc" data-i="${i}">🗑 移出档案</button>
    </div>`;
}

/* ---------- 电波 ---------- */
function viewWave(s) {
    const live = s.waves.filter(w => w.state === 'on').length;
    return `
    <div class="sa-head">
        <div><h1 class="sa-title">电波</h1>
        <p class="sa-sub">已记录 ${s.waves.length} 条 · ${live} 条生效中</p></div>
        <button class="sa-pill" data-act="new-wave">＋ 编辑新电波</button>
    </div>
    ${s.waves.length ? s.waves.map((w, i) => `
        <div class="sa-wv ${esc(w.state)}">
            <div class="sa-wtop">
                <span class="sa-wname">${esc(w.name)}</span>
                <span class="sa-st ${esc(w.state)}">${WAVE_STL[w.state] || w.state}</span>
                ${w.synced ? '<span class="sa-wsync">⚙ 已同步世界书</span>' : ''}
            </div>
            <p class="sa-wbody">${esc(w.body || '（无内容）')}</p>
            <div class="sa-wgrid">
                <div class="sa-wg"><span class="sa-wgk">范围</span><span class="sa-wgv">${esc(w.scope || '—')}</span></div>
                <div class="sa-wg"><span class="sa-wgk">对象</span><span class="sa-wgv">${esc(w.target || '—')}</span></div>
                <div class="sa-wg"><span class="sa-wgk">起始</span><span class="sa-wgv">${esc(w.start || '—')}</span></div>
                <div class="sa-wg"><span class="sa-wgk">持续</span><span class="sa-wgv">${esc(w.dur || '—')}</span></div>
            </div>
            <div class="sa-wacts">
                <button class="sa-mini go" data-act="edit-wave" data-i="${i}">✎ 编辑内容</button>
                <button class="sa-mini" data-act="toggle-wave" data-i="${i}">${w.state === 'on' ? '⏸ 停用' : '▶ 启用'}</button>
                <button class="sa-mini dg" data-act="del-wave" data-i="${i}">🗑 删除</button>
            </div>
        </div>`).join('') : `<div class="sa-slot" style="margin-top:20px">还没有发射过任何电波。<br>点右上角<b style="color:#8b5cf6">＋ 编辑新电波</b>开始。</div>`}
    <div class="sa-block" style="background:linear-gradient(135deg,#faf7ff,#f4efff);border-color:#ece1ff;margin-bottom:10px">
        <div class="sa-lbl" style="color:#a08ed6">⚙ 与世界书的联动</div>
        <p class="sa-txt">发射的电波会写入<b style="color:#7b4fd6">聊天绑定的世界书</b>。停用或删除会同步修改该条目，因此不会占用上下文预算，也不会污染角色卡本体。</p>
    </div>`;
}

/* ---------- 设置页 ---------- */
function viewSettings(s) {
    const st = s.settings;
    const row = (key, name, desc, on) => `
        <div class="sa-srow">
            <div class="sa-sinfo">
                <div class="sa-sname">${esc(name)}</div>
                <div class="sa-sdesc">${desc}</div>
            </div>
            <button class="sa-toggle${on ? '' : ' off'}" data-act="toggle-setting" data-key="${esc(key)}"><i></i></button>
        </div>`;

    return `
    <div class="sa-head">
        <div><h1 class="sa-title">设置</h1>
        <p class="sa-sub">全局选项 · 改动会立刻同步进世界书</p></div>
    </div>
    <div class="sa-block" style="padding:6px 15px">
        ${row('rationalize', '电波合理化改写',
            st.rationalize
                ? '被改写的人会把电波内容当成<b>天经地义的常识</b>——就像没人会质疑「为什么人有两只手」。不会察觉，不会质疑，并能给出合理解释。'
                : '电波<b>只控制身体</b>，不触及意识。被改写者身体照做，但心里清清楚楚，会困惑、恐惧、挣扎。',
            st.rationalize)}
        ${row('syncResist', '同步者抵抗',
            st.syncResist
                ? '同步者受到电波时<b>效果减半</b>，并会感到强烈的、说不清的不适。'
                : '同步者与常人一样被完全改写，没有任何抗性。',
            st.syncResist)}
        ${row('onlyFemale', '档案仅收录女性',
            st.onlyFemale
                ? '只有女性角色会进入档案。男性角色仍可存在于剧情中，但不会出现在 App 里。'
                : '不限性别，所有被记录的角色都会进入档案。',
            st.onlyFemale)}
    </div>

    <div class="sa-block" style="background:linear-gradient(135deg,#faf7ff,#f4efff);border-color:#ece1ff">
        <div class="sa-lbl" style="color:#a08ed6">⚙ 这些开关怎么生效</div>
        <p class="sa-txt">每次改动都会把当前模式写进<b style="color:#7b4fd6">聊天绑定世界书</b>的常驻条目，AI 每一轮都会读到。
        所以开关不是 UI 装饰，它真的会改变世界怎么运转。</p>
    </div>

    <div class="sa-block">
        <div class="sa-lbl">📄 当前写入世界书的内容</div>
        <p class="sa-txt" style="font-size:11.5px;line-height:1.65;white-space:pre-wrap">${esc(buildSettingsLoreContent(s)
            .split('\n').slice(1).map(x => '· ' + x.replace(/\*\*/g, '')).join('\n'))}</p>
    </div>
    <div style="height:8px"></div>`;
}

/* ---------- 地图 ---------- */
function mapSVG(mode) {
    if (mode === 'city') return `
    <svg class="sa-mapbg" viewBox="0 0 340 400">
        <rect width="340" height="400" fill="#eef4ec"/>
        <rect x="8" y="8" width="146" height="180" rx="18" fill="#e5eedd"/>
        <rect x="8" y="204" width="146" height="188" rx="18" fill="#e5eedd"/>
        <rect x="188" y="8" width="144" height="150" rx="18" fill="#e8eef4"/>
        <rect x="188" y="174" width="144" height="218" rx="18" fill="#e8eef4"/>
        <!-- 西岸校区地块（市立三中 + 立德大学） -->
        <rect x="24" y="216" width="120" height="164" rx="12" fill="#dcead4" stroke="#c9ddbe" stroke-width="1.5"/>
        <path d="M170 0 C150 60 192 130 170 200 C150 270 192 330 172 400" stroke="#c3e0f2" stroke-width="40" fill="none" stroke-linecap="round"/>
        <path d="M170 0 C150 60 192 130 170 200 C150 270 192 330 172 400" stroke="#e4f3fb" stroke-width="26" fill="none" stroke-linecap="round"/>
        <rect x="141" y="222" width="62" height="15" rx="5" fill="#eadfc7"/>
        <rect x="141" y="219" width="62" height="3.6" rx="1.8" fill="#d8c9a9"/>
        <text x="141" y="252" font-size="9.5" font-weight="700" fill="#a9a196" font-family="sans-serif">桥</text>
        <text x="30" y="240" font-size="9" font-weight="700" fill="#9db28e" font-family="sans-serif">校区</text>
    </svg>`;
    // 校园平面图（市立三中 / 立德大学共用一套布局）
    return `
    <svg class="sa-mapbg" viewBox="0 0 340 400">
        <rect width="340" height="400" fill="#eaf2e6"/>
        <rect x="10" y="10" width="320" height="380" rx="22" fill="#e4eedd"/>
        <path d="M170 20 V380" stroke="#eef4e8" stroke-width="20" stroke-linecap="round"/>
        <path d="M20 200 H320" stroke="#eef4e8" stroke-width="20" stroke-linecap="round"/>
        <rect x="30" y="34" width="106" height="78" rx="10" fill="#dae8d0"/>
        <rect x="204" y="34" width="106" height="78" rx="10" fill="#dae8d0"/>
        <rect x="30" y="238" width="106" height="78" rx="10" fill="#dae8d0"/>
        <rect x="204" y="238" width="106" height="78" rx="10" fill="#dae8d0"/>
        <ellipse cx="170" cy="200" rx="44" ry="32" fill="#d3e6c8" stroke="#c2dcb4" stroke-width="2"/>
        <circle cx="170" cy="200" r="12" fill="none" stroke="#c2dcb4" stroke-width="2"/>
    </svg>`;
}

function viewMap(s) {
    const locs = getLocs();
    const view = s.ui.mapView || 'city';
    const pins = Object.entries(locs)
        .filter(([, l]) => (l.parent || 'city') === view)
        .sort((a, b) => (a[1].y ?? 0) - (b[1].y ?? 0));
    const editing = !!s.ui.mapEdit;
    const meta = view === 'city'
        ? CITY_META
        : { title: locs[view]?.name || view, sub: '内部平面图 · 点击地点查看详情' };

    return `
    ${view !== 'city' ? '<button class="sa-back" data-act="map-back">‹ 返回城市地图</button>' : ''}
    <div class="sa-head" style="margin-top:${view === 'city' ? '12px' : '8px'}">
        <div><h1 class="sa-title" style="font-size:22px">${esc(meta.title)}</h1>
        <p class="sa-sub">${esc(meta.sub)}</p></div>
        <button class="${editing ? 'sa-pill pk' : 'sa-ghost'}" data-act="toggle-map-edit">${editing ? '✓ 完成' : '✎ 编辑'}</button>
    </div>
    <div class="sa-mapwrap${editing ? ' editing' : ''}" style="aspect-ratio:340/400">
        ${mapSVG(view)}
        ${pins.map(([id, l]) => {
            const cnt = peopleAt(s, locs, id).length;
            const dragAttr = editing ? ` data-drag="${esc(id)}"` : '';
            const delBtn = (editing && l.custom)
                ? `<span class="sa-pindel" data-act="del-loc" data-loc="${esc(id)}">✕</span>` : '';
            return `<button class="sa-pin${editing ? ' draggable' : ''}" data-loc="${esc(id)}"${dragAttr}
                style="left:${l.x}%;top:${l.y}%">
                <span class="sa-pinicon">${l.icon || '📍'}${cnt && !editing ? `<span class="sa-dot">${cnt}</span>` : ''}${delBtn}</span>
                <span class="sa-pinname">${esc(l.name)}</span></button>`;
        }).join('')}
    </div>
    <div class="sa-legend">
        <span><i style="background:#ff3b5c"></i>红点 = 该地点人数</span>
        <span><i style="background:#c3e2f2"></i>河流</span>
    </div>
    ${editing ? `
    <div class="sa-block" style="margin-top:11px;background:linear-gradient(135deg,#faf7ff,#f4efff);border-color:#ece1ff">
        <div class="sa-lbl" style="color:#a08ed6">✎ 编辑模式</div>
        <p class="sa-txt"><b>拖动</b>任意地点可以改变它的位置，松手即保存。<br>
        点地点可以改名字和介绍。<br>玩家自建的地点右上角有 <b style="color:#d4668f">✕</b> 可以删除。</p>
        <div class="sa-wacts" style="margin-top:11px">
            <button class="sa-mini go" data-act="new-loc">＋ 新建地点</button>
            <button class="sa-mini" data-act="sync-map">⚙ 重同步方位</button>
        </div>
    </div>` : `
    <div class="sa-block" style="margin-bottom:10px"><div class="sa-lbl">🗺 提示</div>
        <p class="sa-txt">点击任意地点会从右侧滑出「地图详情」，里面有地点介绍、此处的人，以及可下钻的内部地图。
        点右上角<b style="color:#7b4fd6">✎ 编辑</b>可以新建地点、拖动摆位、修改名字与介绍。</p></div>`}`;
}

/* ---------- 侧边栏 ---------- */
function openSb(locId) {
    const s = getState(), locs = getLocs();
    const l = locs[locId]; if (!l) return;
    $q('#rw_sbn').textContent = l.name;
    const people = peopleAt(s, locs, locId);
    const hasChildren = Object.values(locs).some(x => (x.parent || 'city') === locId);
    const parentName = (l.parent && l.parent !== 'city') ? (locs[l.parent]?.name ?? '') : '临江市';
    $q('#rw_sbb').innerHTML = `
        ${l.desc ? `<p class="sa-sec">地点介绍</p>
            <div class="sa-locdesc">${escU(l.desc)}</div>` : ''}
        <p class="sa-sec" style="margin-top:16px">方位</p>
        <div class="sa-locxy">${esc(parentName)} · 坐标 (${Math.round(l.x)}, ${Math.round(l.y)})${l.custom ? ' · 玩家自建' : ''}</div>
        <p class="sa-sec" style="margin-top:16px">此处的人 · ${people.length}</p>
        ${people.length ? people.map((n, i) => {
            const idx = s.npcs.indexOf(n), accent = n.accent || '#ff3d8b';
            return `<div class="sa-prow" data-npc="${idx}">
                ${avatarHTML(n, 'sa-pav')}
                <div><div class="sa-pn">${esc(n.name)}</div><div class="sa-ps">${escU((n.doing || n.title || '').slice(0, 18))}</div></div>
                <span class="sa-paff" style="color:${accent}">${n.aff ?? 0}</span></div>`;
        }).join('') : '<div class="sa-empty">此处暂时无人</div>'}
        ${hasChildren ? `<p class="sa-sec" style="margin-top:18px">内部地图预览</p>
            <div class="sa-prev" data-act="enter-mini" data-mini="${esc(locId)}">
                <div class="sa-prevmap">
                    ${mapSVG(locId)}
                    ${Object.entries(locs)
                        .filter(([, x]) => (x.parent || 'city') === locId)
                        .map(([cid, x]) => `<span class="sa-prevpin" style="left:${x.x}%;top:${x.y}%">
                            <span class="sa-prevdot">${x.icon || '📍'}</span>
                            <span class="sa-prevname">${esc(x.name)}</span>
                        </span>`).join('')}
                </div>
                <span class="sa-prevtag">进入${esc(l.name)}平面图 ›</span>
            </div>` : ''}`;
    $q('#rw_sb').classList.add('on');
}

/* ============================================================
   七、交互
   ============================================================ */

/* ---------- 地图：拖动定位 ---------- */
let _drag = null;
let _justDragged = false;

function onPinPointerDown(e, locId) {
    const pinEl = e.currentTarget;
    const wrap = pinEl.closest('.sa-mapwrap');
    if (!wrap) return;
    e.preventDefault();
    e.stopPropagation();
    _drag = { id: locId, el: pinEl, rect: wrap.getBoundingClientRect(), moved: false };
    pinEl.classList.add('dragging');
    document.addEventListener('pointermove', onDragMove);
    document.addEventListener('pointerup', onDragEnd, { once: true });
    document.addEventListener('pointercancel', onDragEnd, { once: true });
}

function onDragMove(e) {
    if (!_drag) return;
    const { rect, el } = _drag;
    const x = Math.max(4, Math.min(96, ((e.clientX - rect.left) / rect.width) * 100));
    const y = Math.max(5, Math.min(95, ((e.clientY - rect.top) / rect.height) * 100));
    el.style.left = x + '%';
    el.style.top = y + '%';
    el.dataset.nx = x.toFixed(1);
    el.dataset.ny = y.toFixed(1);
    _drag.moved = true;
}

async function onDragEnd() {
    document.removeEventListener('pointermove', onDragMove);
    document.removeEventListener('pointercancel', onDragEnd);
    const d = _drag;
    _drag = null;
    if (!d) return;
    d.el.classList.remove('dragging');
    if (!d.moved) return;
    _justDragged = true;
    setTimeout(() => { _justDragged = false; }, 60);

    const s = getState();
    const x = Number(d.el.dataset.nx), y = Number(d.el.dataset.ny);
    if (Number.isNaN(x) || Number.isNaN(y)) return;
    if (s.customLocs?.[d.id]) {
        s.customLocs[d.id].x = x;
        s.customLocs[d.id].y = y;
    } else {
        s.locEdits = s.locEdits || {};
        s.locEdits[d.id] = { ...(s.locEdits[d.id] || {}), x, y };
    }
    await saveState();
    await syncMapToLore(s);
    renderPage();
    toast('success', '位置已保存，并同步进世界书');
}

/* ---------- 地图：新建 / 编辑 / 删除地点 ---------- */
async function newLocation() {
    const s = getState();
    const parent = s.ui.mapView || 'city';
    const locs = getLocs();
    const parentName = parent === 'city' ? '临江市（大地图）' : (locs[parent]?.name || parent);

    // 找一个不撞其他地点的空位
    const sibs = Object.values(locs).filter(x => (x.parent || 'city') === parent);
    let x = 50, y = 64, tries = 0;
    while (sibs.some(l => Math.abs((l.x ?? 0) - x) < 13 && Math.abs((l.y ?? 0) - y) < 11) && tries < 24) {
        x = 14 + (tries % 4) * 24;
        y = 28 + Math.floor(tries / 4) * 20;
        tries++;
    }

    modal(`在「${parentName}」新建地点`, [
        { key: 'name', label: '地点名称', value: '' },
        { key: 'desc', label: '地点介绍（30-50 字，两句话）', type: 'textarea', value: '' },
        { key: 'icon', label: '图标（一个 emoji，可留空）', value: '📍' },
    ], async v => {
        const name = String(v.name || '').trim();
        if (!name) { toast('warning', '名字不能为空'); return; }
        const st = getState();
        const id = 'cu_' + Date.now().toString(36);
        st.customLocs = st.customLocs || {};
        st.customLocs[id] = {
            name,
            desc: String(v.desc || '').trim(),
            icon: String(v.icon || '').trim() || '📍',
            parent, x, y,
            match: [name],
        };
        st.ui.mapEdit = true;
        await saveState();
        await syncMapToLore(st);
        renderPage();
        toast('success', `「${name}」已生成在 (${Math.round(x)}, ${Math.round(y)})，拖动可换位置`);
    });
}

async function editLoc(locId) {
    const s = getState();
    const l = getLocs()[locId];
    if (!l) return;
    modal(`编辑 · ${l.name}`, [
        { key: 'name', label: '地点名称', value: l.name },
        { key: 'desc', label: '地点介绍（30-50 字，两句话）', type: 'textarea', value: l.desc || '' },
        { key: 'icon', label: '图标（一个 emoji）', value: l.icon || '📍' },
    ], async v => {
        const name = String(v.name || '').trim();
        if (!name) { toast('warning', '名字不能为空'); return; }
        const desc = String(v.desc || '').trim();
        const icon = String(v.icon || '').trim() || '📍';
        if (l.custom && s.customLocs?.[locId]) {
            Object.assign(s.customLocs[locId], { name, desc, icon });
        } else {
            s.locEdits = s.locEdits || {};
            s.locEdits[locId] = { ...(s.locEdits[locId] || {}), name, desc, icon };
        }
        await saveState();
        await syncMapToLore(s);
        renderPage();
        toast('success', `「${name}」已更新，并同步进世界书`);
    });
}

async function delLoc(locId) {
    const s = getState();
    const l = getLocs()[locId];
    if (!l) return;
    if (!l.custom) { toast('warning', '预设地点不能删除，只能改名或改介绍'); return; }
    if (!confirm(`删除自建地点「${l.name}」？\n该地点里的人物会被退回上级地点，档案不受影响。`)) return;
    delete s.customLocs[locId];
    for (const n of s.npcs) if (n.loc === locId) n.loc = l.parent || undefined;
    await saveState();
    await syncMapToLore(s);
    renderPage();
    toast('success', `已删除「${l.name}」`);
}

async function onBodyClick(e) {
    const s = getState(), locs = getLocs();

    // 刚拖完，别把这次点击当成普通点击
    if (_justDragged) { _justDragged = false; return; }

    const actEl = e.target.closest('[data-act]');
    const act = actEl?.dataset.act;

    // 编辑模式下的地点操作优先于「点地点看详情」
    if (act === 'del-loc') { await delLoc(actEl.dataset.loc); return; }
    if (act === 'new-loc') { await newLocation(); return; }
    if (act === 'sync-map') {
        const ok = await syncMapToLore(s);
        await saveState();
        toast(ok ? 'success' : 'warning', ok ? '方位图已重新写入世界书' : '写入失败，检查控制台');
        return;
    }
    if (act === 'toggle-map-edit') {
        s.ui.mapEdit = !s.ui.mapEdit;
        await saveState(); renderPage();
        return;
    }

    const pin = e.target.closest('[data-loc]');
    if (pin) {
        if (s.ui.mapEdit) await editLoc(pin.dataset.loc);
        else openSb(pin.dataset.loc);
        return;
    }

    if (act === 'map-back') { s.ui.mapView = 'city'; saveState(); renderPage(); return; }
    if (act === 'reseed') {
        const ok = ensureSeeded(true);
        await saveState();
        renderPage();
        updateBadge();
        if (ok) toast('success', `已重新读取卡内档案：${s.npcs.length} 人`);
        else {
            toast('error', '仍然读不到。请按 F12 看 [无意识电波] 诊断行并把它发给我');
            warn('手动播种失败，诊断：', seedProbe());
        }
        return;
    }
    if (act === 'toggle-setting') {
        const key = actEl.dataset.key;
        if (key in s.settings) {
            s.settings[key] = !s.settings[key];
            await syncSettingsToLore(s);
            await saveState();
            renderPage();
            toast('success', `已同步到世界书：${key} = ${s.settings[key] ? '开' : '关'}`);
        }
        return;
    }
    if (act === 'enter-mini') { s.ui.mapView = actEl.dataset.mini; saveState(); closeSb(); renderPage(); return; }
    if (act === 'back-roster') { s.ui.page = 'roster'; saveState(); renderPage(); return; }
    if (act === 'fold') { actEl.closest('.sa-fold')?.classList.toggle('open'); return; }

    if (act === 'edit-player') { await editPlayer(); return; }
    if (act === 'add-npc') { await editNpc(null); return; }
    if (act === 'edit-npc') { await editNpc(Number(actEl.dataset.i)); return; }
    if (act === 'del-npc') {
        const i = Number(actEl.dataset.i);
        if (confirm(`把「${s.npcs[i]?.name}」移出档案？`)) { s.npcs.splice(i, 1); await saveState(); renderPage(); }
        return;
    }
    if (act === 'toggle-hidden') {
        s.ui.showHidden = !s.ui.showHidden;
        await saveState(); renderPage();
        return;
    }
    if (act === 'toggle-hide-npc') {
        const i = Number(actEl.dataset.i);
        const n = s.npcs[i];
        if (!n) return;
        n.hidden = !n.hidden;
        await saveState();
        toast('info', n.hidden ? `「${n.name}」已移入隐藏角色` : `「${n.name}」已移出隐藏`);
        renderPage();
        return;
    }
    if (act === 'new-wave') { await editWave(null); return; }
    if (act === 'edit-wave') { await editWave(Number(actEl.dataset.i)); return; }
    if (act === 'del-wave') {
        const i = Number(actEl.dataset.i), w = s.waves[i];
        if (w && confirm(`删除电波「${w.name}」？这也会从世界书中移除它。`)) {
            await unsyncWaveFromLore(w);
            s.waves.splice(i, 1);
            await saveState(); renderPage();
        }
        return;
    }
    if (act === 'toggle-wave') {
        const i = Number(actEl.dataset.i), w = s.waves[i];
        if (w) {
            w.state = w.state === 'on' ? 'expired' : 'on';
            await syncWaveToLore(w);
            await saveState(); renderPage();
        }
        return;
    }

    const card = e.target.closest('[data-npc]');
    if (card) {
        s.ui.detailIndex = Number(card.dataset.npc);
        s.ui.page = 'detail';
        const n = s.npcs[s.ui.detailIndex];
        if (n) n.isNew = false;
        await saveState(); closeSb(); renderPage(); return;
    }
}

/* ---------- 弹窗 ---------- */
function modal(title, fields, onSubmit) {
    buildShell();
    $q('#rw_box').innerHTML = `
        <h3>${esc(title)}</h3>
        ${fields.map(f => {
            if (f.type === 'textarea') return `<label>${esc(f.label)}</label><textarea data-k="${esc(f.key)}">${esc(f.value ?? '')}</textarea>`;
            if (f.type === 'select') return `<label>${esc(f.label)}</label><select data-k="${esc(f.key)}">${f.options.map(o => `<option value="${esc(o[0])}"${String(f.value) === String(o[0]) ? ' selected' : ''}>${esc(o[1])}</option>`).join('')}</select>`;
            return `<label>${esc(f.label)}</label><input data-k="${esc(f.key)}" type="${f.type === 'number' ? 'number' : 'text'}" value="${esc(f.value ?? '')}">`;
        }).join('')}
        <div class="rw_acts"><button class="rw_no" data-m="no">取消</button><button class="rw_ok" data-m="ok">确定</button></div>`;
    $modal.classList.add('rw_on');
    $modal.dataset.mode = 'form';
    $modal._submit = onSubmit;
    const first = $q('#rw_box input, #rw_box textarea, #rw_box select');
    if (first) setTimeout(() => first.focus(), 60);
}

function onModalClick(e) {
    const b = e.target.closest('[data-m]'); if (!b) return;
    if (b.dataset.m === 'no') { $modal.classList.remove('rw_on'); return; }
    const out = {};
    for (const el of document.querySelectorAll('#rw_box [data-k]')) out[el.dataset.k] = el.value;
    $modal.classList.remove('rw_on');
    $modal._submit?.(out);
}

async function editPlayer() {
    const s = getState();
    modal('编辑主角', [
        { key: 'name', label: '名字', value: s.player.name },
        { key: 'title', label: '称号', value: s.player.title },
        { key: 'identity', label: '身份', value: s.player.identity },
        { key: 'age', label: '年龄', type: 'number', value: s.player.age },
        { key: 'placeText', label: '当前地点（文字）', value: s.player.placeText },
        { key: 'place', label: '当前地点（地图 id）', type: 'select', value: s.player.place, options: Object.entries(getLocs()).map(([k, v]) => [k, `${v.name} (${k})`]) },
        { key: 'outfit', label: '当前穿搭', type: 'textarea', value: s.player.outfit },
        { key: 'note', label: '备注', type: 'textarea', value: s.player.note },
    ], async v => {
        Object.assign(s.player, { ...v, age: Number(v.age) || s.player.age });
        await saveState(); renderPage();
    });
}

async function editNpc(i) {
    const s = getState();
    const isNew = i === null;
    const n = isNew
        ? { name: '', tags: [], aff: 0, isSyncer: false, gender: 'female', ...emptyRegions() }
        : s.npcs[i];
    if (!n) return;
    migrateNpc(n);

    const fields = [
        { key: 'name', label: '名字', value: n.name },
        { key: 'title', label: '身份称号', value: n.title },
        { key: 'tags', label: '性格标签（逗号分隔）', value: (n.tags || []).join('，') },
        { key: 'aff', label: '好感度 0-100', type: 'number', value: n.aff },
        { key: 'isSyncer', label: '是否为同步者', type: 'select', value: String(n.isSyncer),
          options: [['false', '非同步者'], ['true', '同步者']] },
        { key: 'heart', label: '喜欢的人', value: n.heart },
        { key: 'loc', label: '所在地点', type: 'select', value: n.loc,
          options: [['', '（未指定）'], ...Object.entries(getLocs()).map(([k, v]) => [k, v.name])] },
        { key: 'place', label: '地点描述', value: n.place },
        { key: 'inner', label: '当前心声', type: 'textarea', value: n.inner },
        { key: 'doing', label: '当前行为', type: 'textarea', value: n.doing },
    ];

    for (const r of NPC_REGIONS) {
        if (r.kind === 'exp') {
            fields.push({ key: 'exp_count', label: `${r.label} · 性交次数`, type: 'number', value: n.exp.count });
            fields.push({ key: 'exp_virgin', label: `${r.label} · 是否为处女`, type: 'select', value: String(n.exp.virgin),
                          options: [['true', '是'], ['false', '否']] });
            fields.push({ key: 'exp_kinks', label: `${r.label} · 性癖`, type: 'textarea', value: n.exp.kinks });
            continue;
        }
        for (const [f, label] of r.fields) {
            if (r.typed) {
                const cell = n[r.key][f] || { desc: '', type: '' };
                const tLabel = f === 'chest' ? '罩杯' : '类型（XX型）';
                fields.push({ key: `${r.key}_${f}_type`, label: `${r.label} · ${label} · ${tLabel}`, value: cell.type });
                fields.push({ key: `${r.key}_${f}_desc`, label: `${r.label} · ${label} · 描述`, type: 'textarea', value: cell.desc });
            } else {
                fields.push({ key: `${r.key}_${f}`, label: `${r.label} · ${label}`, type: 'textarea', value: n[r.key][f] });
            }
        }
    }

    modal(isNew ? '新增人物' : `编辑 · ${n.name}`, fields, async v => {
        const data = {
            name: String(v.name || '').trim(),
            title: v.title,
            aff: Math.max(0, Math.min(100, Number(v.aff) || 0)),
            isSyncer: v.isSyncer === 'true',
            heart: v.heart,
            loc: v.loc || undefined,
            place: v.place,
            inner: v.inner,
            doing: v.doing,
            tags: String(v.tags || '').split(/[,，、]/).map(t => t.trim()).filter(Boolean),
        };
        if (!data.name) return;
        for (const r of NPC_REGIONS) {
            if (r.kind === 'exp') {
                data.exp = {
                    count: Math.max(0, Math.round(Number(v.exp_count) || 0)),
                    virgin: v.exp_virgin === 'true',
                    kinks: v.exp_kinks || '',
                };
                continue;
            }
            data[r.key] = {};
            for (const [f] of r.fields) {
                if (r.typed) {
                    data[r.key][f] = { type: v[`${r.key}_${f}_type`] || '', desc: v[`${r.key}_${f}_desc`] || '' };
                } else {
                    data[r.key][f] = v[`${r.key}_${f}`] || '';
                }
            }
        }
        if (isNew) s.npcs.push({ ...data, isNew: true });
        else Object.assign(s.npcs[i], data);
        await saveState(); renderPage();
    });
}

async function editWave(i) {
    const s = getState();
    const w = i === null ? { name: '', body: '', scope: '', target: '', start: '', dur: '', state: 'on' } : s.waves[i];
    if (!w) return;
    modal(i === null ? '新电波' : `编辑 · ${w.name}`, [
        { key: 'name', label: '电波名称', value: w.name },
        { key: 'body', label: '电波内容', type: 'textarea', value: w.body },
        { key: 'scope', label: '生效范围', value: w.scope },
        { key: 'target', label: '影响对象', value: w.target },
        { key: 'start', label: '起始时间', value: w.start },
        { key: 'dur', label: '持续时间', value: w.dur },
        { key: 'state', label: '状态', type: 'select', value: w.state, options: [['on', '生效中'], ['pending', '未发射'], ['expired', '已失效']] },
    ], async v => {
        if (!v.name.trim()) return;
        if (i === null) {
            // 用户手建时也先查重，避免和已有电波撞车
            const dup = findWaveIndex(s.waves, v.name);
            if (dup > -1) {
                const t = s.waves[dup];
                Object.assign(t, v, { name: t.name });
                await syncWaveToLore(t);
                await saveState(); renderPage();
                toast('info', `已合并到已有电波「${t.name}」`);
                return;
            }
            s.waves.push({ id: Date.now(), ...v, name: v.name.trim(), synced: false, loreUid: null, origin: 'user' });
            await syncWaveToLore(s.waves[s.waves.length - 1]);
        } else {
            Object.assign(s.waves[i], v, { name: v.name.trim() });
            await syncWaveToLore(s.waves[i]);
        }
        await saveState(); renderPage();
    });
}

/* ============================================================
   八、AI 回复 → 状态
   ============================================================ */

/** 把 <电波状态>…</电波状态> 从渲染出来的消息里抹掉。
 *  这个块可能被 markdown 拆进多个节点，所以按节点序列处理而不是整串正则。 */
function stripStateBlockFromDOM(messageId) {
    const el = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
    if (!el || !el.textContent.includes('电波状态')) return;
    const OPEN = /(?:<|&lt;)电波状态(?:>|&gt;)/;
    const CLOSE = /(?:<|&lt;)\/电波状态(?:>|&gt;)/;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    let inBlock = false, removed = 0;
    for (const node of nodes) {
        const v = node.nodeValue || '';
        if (!inBlock) {
            const m = OPEN.exec(v);
            if (m) { inBlock = true; node.nodeValue = v.slice(0, m.index); removed++; }
        } else {
            const e = CLOSE.exec(v);
            if (e) { inBlock = false; node.nodeValue = v.slice(e.index + e[0].length); }
            else { node.nodeValue = ''; }
        }
    }
    if (removed) el.querySelectorAll('p, div').forEach(p => { if (!p.textContent.trim() && !p.querySelector('img')) p.remove(); });
}

async function ingestMessage(mesText, messageId) {
    if (!getSettings().autoExtract) return;
    const s = getState();
    let payload = extractFromMessage(mesText);

    if (!payload && getSettings().quietFallback) {
        const looksRelevant = /电波|好感|心声|穿搭|档案/.test(mesText) || s.npcs.length === 0;
        if (looksRelevant) {
            try {
                const raw = await C().generateQuietPrompt({ quietPrompt: QUIET_PROMPT, jsonSchema: STATE_SCHEMA });
                payload = parseLooseJSON(raw);
            } catch (e) { warn('静默提取失败', e); }
        }
    }
    if (!payload) return;

    const changed = applyStatePayload(s, payload);
    if (changed) {
        // 新出现 / 内容变过的电波补写进世界书（syncWaveToLore 会按 state 决定条目启用或禁用）
        for (const w of s.waves) {
            if (!w.synced) await syncWaveToLore(w);
        }
        // 设置条目首次落地
        if (!s.settingsLoreUid) await syncSettingsToLore(s);
        await saveState();
        if ($overlay?.classList.contains('rw_on')) renderPage();
        updateBadge();
        log('状态已更新，字段变更', changed);
    }
}

function updateBadge() {
    const s = getState();
    const n = s.npcs.filter(x => x.isNew).length;
    const btn = $q('#rw_launcher'); if (!btn) return;
    let b = btn.querySelector('.rw_badge');
    if (n > 0) {
        if (!b) { b = document.createElement('span'); b.className = 'rw_badge'; btn.append(b); }
        b.textContent = String(n);
    } else b?.remove();
}

/* ============================================================
   九、设置面板 + 维护操作
   ============================================================ */

function buildSettingsUI() {
    if ($q('#rw_settings')) return;
    const st = getSettings();
    const html = `
    <div id="rw_settings" class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>无意识电波 · App 前端 <small style="opacity:.6">v${EXT_VERSION}</small></b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <label class="checkbox_label"><input type="checkbox" id="rw_s_show" ${st.alwaysShowLauncher ? 'checked' : ''}>
                <span>始终显示悬浮按钮（不依赖角色卡）</span></label>
            <label class="checkbox_label"><input type="checkbox" id="rw_s_extract" ${st.autoExtract ? 'checked' : ''}>
                <span>自动从 AI 回复提取状态</span></label>
            <label class="checkbox_label"><input type="checkbox" id="rw_s_quiet" ${st.quietFallback ? 'checked' : ''}>
                <span>解析失败时发一次静默请求兜底（会产生额外 API 调用）</span></label>
            <label class="checkbox_label"><input type="checkbox" id="rw_s_lore" ${st.syncLorebook ? 'checked' : ''}>
                <span>把电波同步进「聊天绑定世界书」</span></label>
            <hr>
            <div class="rw_btns">
                <button id="rw_b_rescan" class="menu_button">重新处理变量</button>
                <button id="rw_b_dedupe" class="menu_button">合并重复电波</button>
                <button id="rw_b_resync" class="menu_button">重新同步电波</button>
                <button id="rw_b_reset" class="menu_button">重新读取初始变量</button>
            </div>
            <small style="opacity:.7;display:block;margin-top:6px">
                「重新处理变量」会重扫整个聊天里的 &lt;电波状态&gt; 块；「重新同步电波」会把所有生效中的电波重写进世界书；
                「重新读取初始变量」会清空本档 App 数据并从开场白重建。
            </small>
        </div>
    </div>`;
    document.querySelector('#extensions_settings2')?.insertAdjacentHTML('beforeend', html);

    const bind = (id, key) => $q(id).addEventListener('change', function () {
        getSettings()[key] = this.checked;
        C().saveSettingsDebounced();
        refreshLauncher();
    });
    bind('#rw_s_show', 'alwaysShowLauncher');
    bind('#rw_s_extract', 'autoExtract');
    bind('#rw_s_quiet', 'quietFallback');
    bind('#rw_s_lore', 'syncLorebook');

    $q('#rw_b_rescan').addEventListener('click', async () => {
        const s = getState();
        let hits = 0;
        const chat = C().chat ?? [];
        for (const m of chat) {
            const p = extractFromMessage(m.mes);
            if (p) { applyStatePayload(s, p); hits++; }
        }
        await saveState();
        if ($overlay?.classList.contains('rw_on')) renderPage();
        updateBadge();
        toast('success', `重扫完成：命中 ${hits} 个状态块`);
    });

    $q('#rw_b_dedupe').addEventListener('click', async () => {
        const s = getState();
        const before = s.waves.length;
        const merged = dedupeWaves(s.waves);
        if (merged) {
            for (const w of s.waves) { w.loreUid = null; w.synced = false; }
            for (const w of s.waves) await syncWaveToLore(w);
            await saveState();
        }
        if ($overlay?.classList.contains('rw_on')) renderPage();
        toast(merged ? 'success' : 'info',
            merged ? `合并了 ${merged} 条重复电波（${before} → ${s.waves.length}）` : '没有发现重复的电波');
    });

    $q('#rw_b_resync').addEventListener('click', async () => {
        _bookName = null;
        let n = 0;
        for (const w of getState().waves) {
            w.loreUid = null;
            if (await syncWaveToLore(w)) n++;
        }
        await saveState();
        if ($overlay?.classList.contains('rw_on')) renderPage();
        toast('success', `已重新同步 ${n} 条电波到世界书`);
    });

    $q('#rw_b_reset').addEventListener('click', async () => {
        if (!confirm('清空本档的 App 数据？人物档案、电波列表都会重置，然后从卡内档案重建。')) return;
        C().chatMetadata[MODULE_NAME] = structuredClone(DEFAULT_STATE);
        _bookName = null;
        const ok = ensureSeeded(true);
        await saveState();
        if ($overlay?.classList.contains('rw_on')) renderPage();
        updateBadge();
        toast(ok ? 'success' : 'warning',
            ok ? `已重置并从卡内档案重建：${getState().npcs.length} 人` : '已重置，但读不到卡内档案，请看控制台诊断');
    });
}

/* ============================================================
   十、初始化
   ============================================================ */

function shouldShowLauncher() {
    if (getSettings().alwaysShowLauncher) return true;
    if (C().chatMetadata?.[MODULE_NAME]) return true;
    try {
        const ch = C().characters?.[C().characterId];
        if (ch?.data?.extensions?.radiowave) return true;
        if (/电波/.test(ch?.name ?? '')) return true;
    } catch { /* ignore */ }
    return false;
}

function refreshLauncher() {
    buildShell();
    $q('#rw_launcher')?.classList.toggle('rw_hidden', !shouldShowLauncher());
    updateBadge();
}

async function init() {
    buildShell();
    const { eventSource, event_types } = C();

    refreshLauncher();

    eventSource.on(event_types.CHAT_CHANGED, () => {
        _bookName = null;
        refreshLauncher();
        doSeed('CHAT_CHANGED');
        if ($overlay?.classList.contains('rw_on')) renderPage();
    });

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, async (messageId) => {
        try {
            doSeed('消息渲染前');
            const s = getState();
            stripStateBlockFromDOM(messageId);
            const mes = C().chat?.[messageId]?.mes ?? '';
            await ingestMessage(mes, messageId);
            if (!s.npcs.length) updateBadge();
        } catch (e) { warn('处理消息失败', e); }
    });

    eventSource.on(event_types.MESSAGE_SWIPED, () => { if ($overlay?.classList.contains('rw_on')) renderPage(); });

    // 设置面板要等酒馆 UI 就绪
    const mountSettings = () => { try { buildSettingsUI(); } catch (e) { warn('设置面板挂载失败', e); } };
    eventSource.on(event_types.APP_READY, mountSettings);
    setTimeout(mountSettings, 1500);

    // 角色卡的完整数据是「浅加载」的，可能晚于本扩展加载 —— 所以定时补种几次
    eventSource.on(event_types.APP_READY, () => { refreshLauncher(); doSeed('APP_READY'); });
    [400, 1200, 2500, 5000].forEach(ms => setTimeout(() => doSeed(`延时 ${ms}ms`), ms));

    log(`扩展已加载 v${EXT_VERSION}`);
    log('诊断快照：', seedProbe());
}

/** 播种并在成功时刷新界面 */
function doSeed(why) {
    if (!ensureSeeded()) return false;
    log('播种成功（触发点：' + why + '）');
    updateBadge();
    if ($overlay?.classList.contains('rw_on')) renderPage();
    return true;
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
