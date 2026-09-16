/* =========================================================================
 * 在 Node 里直接跑 app.js 的纯逻辑。
 *
 * 做法：给一个假的 DOM + 可控的「现在」，把 app.js 的源码 eval 一遍，
 * 并在末尾塞一个 window.__T 把内部函数暴露出来（源文件本身不动）。
 *
 * 用法：node tools/test-logic.js
 * ========================================================================= */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app/assets/www/app.js'), 'utf8');
const RealDate = Date;

let fails = 0;
function ok(name, cond, extra) {
    console.log((cond ? '  [PASS] ' : '  [FAIL] ') + name + (extra ? '   ' + extra : ''));
    if (!cond) fails++;
}
/** 本机时区的 y-m-d h:m 对应的毫秒数 */
function at(y, m, d, hh, mm) { return new RealDate(y, m - 1, d, hh, mm, 0, 0).getTime(); }

/* ---------------------------------------------------------------- 假 DOM */

function fakeEl() {
    const o = {
        style: {}, dataset: {}, hidden: false, innerHTML: '', textContent: '', value: '',
        scrollTop: 0, scrollHeight: 100, offsetHeight: 800, offsetWidth: 400,
        classList: { add() { }, remove() { }, toggle() { }, contains() { return false; } }
    };
    ['addEventListener', 'removeEventListener', 'appendChild', 'removeChild', 'setAttribute',
        'toggleAttribute', 'focus', 'setSelectionRange', 'click', 'dispatchEvent'].forEach(k => { o[k] = () => { }; });
    o.querySelector = () => fakeEl();
    o.querySelectorAll = () => [];
    o.closest = () => null;
    o.getAttribute = () => null;
    o.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 800 });
    return o;
}

/** 用给定的「现在」和种子数据启动一次应用，返回暴露出来的内部函数 */
function boot(nowMs, seedDb) {
    class FakeDate extends RealDate {
        constructor(...a) { if (a.length === 0) super(nowMs); else super(...a); }
        static now() { return nowMs; }
    }

    const prev = { window: global.window, document: global.document, localStorage: global.localStorage };
    const win = {};
    const els = {};                       // 按 id 缓存，这样能读回渲染出来的 innerHTML
    const el = id => (els[id] = els[id] || fakeEl());
    global.window = win;
    global.Date = FakeDate;
    global.document = {
        readyState: 'complete',
        getElementById: el,
        querySelector: () => fakeEl(),
        querySelectorAll: () => [],
        createElement: () => fakeEl(),
        addEventListener: () => { },
        body: fakeEl(),
        documentElement: fakeEl()
    };
    global.localStorage = {
        getItem: () => (seedDb ? JSON.stringify(seedDb) : null),
        setItem: () => { }, removeItem: () => { }
    };
    global.setInterval = () => 0;
    global.setTimeout = () => 0;
    global.confirm = () => false;
    global.alert = () => { };

    // 在 IIFE 内部再挂一个测试出口
    const cut = SRC.lastIndexOf('})();');
    const patched = SRC.slice(0, cut) + `
    window.__T = {
        defaults: defaults, autoWeek: autoWeek, colorOf: colorOf, colorIndexOf: colorIndexOf,
        courseKey: courseKey, setMark: setMark, getMark: getMark, markKey: markKey,
        sectionOf: sectionOf, setCourseTag: setCourseTag,
        buildPlan: buildPlan, syncMsgs: syncMsgs,
        planImgs: function () { return planImgs; }, msgFiles: msgFiles,
        pickFortune: pickFortune, FORTUNE_KIND: FORTUNE_KIND, FORTUNE_SET: FORTUNE_SET,
        drawFortune: drawFortune, fortuneStreak: fortuneStreak, fortuneCounts: fortuneCounts,
        fortuneDays: fortuneDays, fortuneLog: fortuneLog, drawFortuneSheet: drawFortuneSheet,
        todoApplies: todoApplies, todoWhenText: todoWhenText, todoById: todoById,
        setTodos: function (a) { DB.todos = a; },
        setFortuneAll: function (v) { fortuneAll = v; },
        rawCourses: rawCourses, dayCourses: dayCourses, canSwap: canSwap,
        applySwap: applySwap, disableRange: disableRange, dayOverride: dayOverride,
        visibleDays: visibleDays, weekOf: weekOf, ymd: ymd,
        renderKb: renderKb, refresh: refresh,
        PALETTE: PALETTE, totalWeeks: totalWeeks,
        entriesCount: function () { return DB.entries.length; },
        setDB: function (d) { DB = d; }, getDB: function () { return DB; },
        week: function () { return currentWeek; }
    };
    ` + SRC.slice(cut);

    (0, eval)(patched);                       // eslint-disable-line no-eval

    const T = win.__T;
    T.html = id => el(id).innerHTML;      // 读回某个元素被渲染成的 HTML
    T.__restore = function () {
        global.Date = RealDate;
        global.window = prev.window;
        global.document = prev.document;
        global.localStorage = prev.localStorage;
    };
    return T;
}

/** 可控的课表：一门课在周一出现两次以上，周五下午有课 */
function makeDB() {
    const e = (id, name, code, day, s, ee, weeks) =>
        ({ id: id, name: name, code: code, day: day, s: s, e: ee, weeks: weeks || [3, 4], tag: 'none',
           teacher: name.slice(0, 2) + '老师', room: 'A' + (1000 + s * 10 + day) });
    return {
        v: 1,
        meta: { student: '测试', sid: '', term: '', firstWeekMonday: '2026-08-31' },
        colors: {}, marks: {}, days: {}, todos: [], msgs: {},
        entries: [
            e('a1', '工科数学分析(一)', '040101211', 1, 1, 2),
            e('a2', '工科数学分析(一)', '040101211', 5, 1, 2),
            e('b1', '基础物理(一)', '041100954', 1, 3, 4),
            e('c1', '高级语言程序设计(C++)(一)', '045100452', 1, 5, 6),
            e('d1', '身体素质', '021301', 1, 7, 8),
            e('f1', '工程制图', '074102992', 5, 5, 6)
        ],
        settings: {
            dailyOn: true, dailyTimes: ['08:00', '13:00', '18:00'], dailyWhenEmpty: false,
            preOn: true, preMin: 10, notifyNormal: true, notifyEasy: false,
            signOn: false, periods: 11, totalWeeks: 20, timetable: 'dxc', weekend: 'auto'
        }
    };
}

console.log('\n=== 1. 前 12 门课颜色互不重复 ===');
{
    const T = boot(at(2026, 9, 14, 8, 0));
    const db = makeDB();
    db.entries = [];
    for (let i = 0; i < 12; i++) {
        db.entries.push({ id: 'x' + i, name: '课程' + i, code: 'C' + i, day: (i % 5) + 1, s: 1, e: 1, weeks: [3], tag: 'none' });
    }
    T.setDB(db);
    const used = db.entries.map(x => T.colorIndexOf(x) % T.PALETTE.length);
    ok('12 门课颜色互不重复', new Set(used).size === 12, JSON.stringify(used));
    ok('色板够用', T.PALETTE.length >= 12, 'PALETTE=' + T.PALETTE.length);
    T.__restore();
}

console.log('\n=== 2. 同一门课（多节课）颜色一致 ===');
{
    const T = boot(at(2026, 9, 14, 8, 0));
    const db = makeDB();
    T.setDB(db);
    const g = {};
    db.entries.forEach(x => { const k = T.courseKey(x); (g[k] = g[k] || []).push(T.colorOf(x)); });
    Object.keys(g).forEach(k => ok('「' + k + '」' + g[k].length + ' 节同色', new Set(g[k]).size === 1, g[k][0]));
    const per = Object.keys(g).map(k => g[k][0]);
    ok('不同课程颜色不撞车', new Set(per).size === per.length, per.join(' '));
    T.__restore();
}

console.log('\n=== 3. 自定义颜色覆盖自动分配 ===');
{
    const T = boot(at(2026, 9, 14, 8, 0));
    const db = makeDB();
    T.setDB(db);
    const before = T.colorOf(db.entries[2]);
    db.colors['040101211'] = 9;
    ok('改了「工科数学分析」，它的两节一起变',
        T.colorOf(db.entries[0]) === T.PALETTE[9] && T.colorOf(db.entries[1]) === T.PALETTE[9],
        T.colorOf(db.entries[0]));
    ok('别的课不受影响', T.colorOf(db.entries[2]) === before, before);
    T.__restore();
}

console.log('\n=== 4. 默认值 ===');
{
    const T = boot(at(2026, 9, 14, 8, 0));
    const d = T.defaults();
    ok('课前提醒默认 10 分钟', d.settings.preMin === 10, '实际 ' + d.settings.preMin);
    ok('签到默认关闭', d.settings.signOn === false);
    ok('有 colors 字段', !!d.colors && typeof d.colors === 'object');
    T.__restore();
}

console.log('\n=== 5. 本周课上完自动跳下一周 ===');
{
    const cases = [
        ['周一 08:00 还没上课', [2026, 9, 14, 8, 0], 3],
        ['周五 15:00 下午课没下课', [2026, 9, 18, 15, 0], 3],
        ['周五 18:00 全周上完', [2026, 9, 18, 18, 0], 4],
        ['周日 12:00 早已结束', [2026, 9, 20, 12, 0], 4],
        ['假期周（第1周没课）不跳', [2026, 9, 1, 20, 0], 1]
    ];
    cases.forEach(c => {
        const T = boot(at(c[1][0], c[1][1], c[1][2], c[1][3], c[1][4]), makeDB());
        ok(c[0] + ' → 第 ' + c[2] + ' 周', T.autoWeek() === c[2], '实际 第 ' + T.autoWeek() + ' 周');
        ok('  · 打开时 currentWeek 一致', T.week() === c[2], '实际 ' + T.week());
        T.__restore();
    });

    const db = makeDB();
    db.settings.totalWeeks = 20;
    db.entries.forEach(x => { x.weeks = [20]; });
    // 第 20 周周五（2027-01-15）晚上：全周上完，但已经是最后一周，不能再往后跳
    const T = boot(at(2027, 1, 15, 20, 0), db);
    ok('最后一周上完不再往后跳', T.autoWeek() === 20, '实际 第 ' + T.autoWeek() + ' 周');
    T.__restore();

    // 学期彻底结束之后（第 23 周）：autoWeek 会越过总周数，靠 clampWeek 收回最后一周
    const T2 = boot(at(2027, 2, 1, 12, 0), db);
    ok('学期结束后停在最后一周', T2.week() === 20, '实际 第 ' + T2.week() + ' 周');
    T2.__restore();
}

console.log('\n=== 6. 备注附件参与「标记是否为空」的判断 ===');
{
    const T = boot(at(2026, 9, 14, 8, 0), makeDB());
    const db = T.getDB();
    const e = db.entries[0];
    T.setMark(e, 3, { files: [{ n: 'x.png', t: 'image/png', d: 'data:image/png;base64,AAAA' }] });
    ok('只有附件、没文字时标记保留', (T.getMark(e, 3).files || []).length === 1);
    T.setMark(e, 3, { files: null, note: '' });
    ok('清空后标记被删除', Object.keys(db.marks).length === 0, JSON.stringify(db.marks));
    T.setMark(e, 3, { note: '带实验报告' });
    ok('只有文字时也保留', T.getMark(e, 3).note === '带实验报告');
    T.__restore();
}

console.log('\n=== 7. 上午 / 下午 / 晚上的分段 ===');
{
    const expect = {
        dxc: { 1: '上午', 4: '上午', 5: '下午', 8: '下午', 9: '晚上', 11: '晚上' },
        ws: { 1: '上午', 4: '上午', 5: '下午', 8: '下午', 9: '晚上', 12: '晚上' }
    };
    Object.keys(expect).forEach(tt => {
        const db = makeDB();
        db.settings.timetable = tt;
        const T = boot(at(2026, 9, 14, 8, 0), db);
        const got = {};
        Object.keys(expect[tt]).forEach(p => { got[p] = T.sectionOf(+p); });
        const okAll = Object.keys(expect[tt]).every(p => got[p] === expect[tt][p]);
        ok(tt + ' 作息分段正确', okAll, JSON.stringify(got));
        T.__restore();
    });

    // 分段点必须落在 4 和 8 后面（也就是 12:15 下课后、17:20 下课后）
    const T = boot(at(2026, 9, 14, 8, 0), makeDB());
    const cut = [];
    for (let p = 1; p < 11; p++) if (T.sectionOf(p) !== T.sectionOf(p + 1)) cut.push(p);
    ok('分割线正好两条，在 4 和 8 之后', cut.join(',') === '4,8', cut.join(','));
    T.__restore();
}

console.log('\n=== 8. 标记作用于整门课（同一门课的所有节次一起变） ===');
{
    const T = boot(at(2026, 9, 14, 8, 0), makeDB());
    const db = T.getDB();
    const math = db.entries.filter(x => /工科数学/.test(x.name));
    const phy = db.entries.filter(x => /基础物理/.test(x.name))[0];
    math[0].tag = 'easy';                       // 先给其中一节打上，模拟旧数据
    ok('造好了「同门课只有一节有标记」的初始状态',
        math[0].tag === 'easy' && math[1].tag === 'none', math.map(x => x.tag).join('/'));

    T.setCourseTag(math[0], 'important');
    ok('改一节 → 同一门课全部跟着变', math.every(x => x.tag === 'important'), math.map(x => x.tag).join('/'));
    ok('别的课不受影响', phy.tag === 'none', phy.tag);

    T.setCourseTag(math[0], 'none');
    ok('取消标记也作用于整门课', math.every(x => x.tag === 'none'), math.map(x => x.tag).join('/'));
    T.__restore();
}

console.log('\n=== 9. 通知计划：不重复、内容对得上本周 ===');
{
    // (a) 课表里塞一条完全重复的课，计划里不能出现两条一样的提醒
    const db = makeDB();
    const dupe = JSON.parse(JSON.stringify(db.entries[0]));
    dupe.id = 'dupe1';
    db.entries.push(dupe);
    const T = boot(at(2026, 9, 14, 7, 0), db);
    const plan = T.buildPlan();
    const ks = Object.keys(plan).filter(k => k[0] === 'p');
    const sigs = ks.map(k => plan[k].at + '|' + plan[k].title);
    ok('重复的课程条目不会推出重复提醒', new Set(sigs).size === sigs.length,
        ks.length + ' 条提醒 / ' + new Set(sigs).size + ' 种内容');
    T.__restore();
}
{
    // (b) key 里不带课程序号 → 增删课程后已有提醒的 key 不变（否则消息中心会攒重复）
    const db = makeDB();
    const T = boot(at(2026, 9, 14, 7, 0), db);
    const k1 = Object.keys(T.buildPlan()).filter(k => k[0] === 'p');
    db.entries.unshift({ id: 'new1', name: '早八新课', code: 'NEW', day: 1, s: 1, e: 1, weeks: [3, 4], tag: 'none' });
    T.setDB(db);
    const k2 = Object.keys(T.buildPlan()).filter(k => k[0] === 'p');
    const gone = k1.filter(k => k2.indexOf(k) < 0);
    ok('新增课程不会让已有提醒换 key', gone.length === 0, gone.slice(0, 3).join(' '));
    T.__restore();
}
{
    // (c) 每条课前提醒的老师/地点，必须来自本周真正要上的那一节
    const db = makeDB();
    const T = boot(at(2026, 9, 14, 7, 0), db);
    const plan = T.buildPlan();
    let bad = [];
    Object.keys(plan).filter(k => k[0] === 'p').forEach(k => {
        const e = db.entries.filter(x => x.id === k.split('_')[1])[0];
        if (!e) { bad.push(k + ' 找不到课'); return; }
        if (!plan[k].body.includes(e.teacher)) bad.push(e.name + ' 老师不符');
        if (!plan[k].body.includes(e.room)) bad.push(e.name + ' 地点不符');
    });
    ok('提醒里的老师和地点都对', bad.length === 0, bad.slice(0, 4).join(' | '));
    T.__restore();
}

console.log('\n=== 10. 消息中心不会攒重复消息 ===');
{
    const db = makeDB();
    const t = new RealDate(2026, 8, 15, 8, 0).getTime();
    db.msgs = {
        old1: { at: t, title: 'T', body: 'B', kind: 'preclass', read: false },
        old2: { at: t, title: 'T', body: 'B', kind: 'preclass', read: true },
        other: { at: t + 60000, title: 'T2', body: 'B2', kind: 'daily', read: false }
    };
    const T = boot(at(2026, 9, 14, 7, 0), db);
    const g = T.getDB();
    T.syncMsgs({});
    const keys = Object.keys(g.msgs);
    ok('内容相同的旧消息被合并成一条', keys.length === 2, keys.join(','));
    ok('合并后仍保持未读', g.msgs.old1 && g.msgs.old1.read === false, JSON.stringify(g.msgs.old1));
    T.__restore();
}

console.log('\n=== 11. 单日禁用 / 调休 ===');
{
    // makeDB：周一有 4 节（a1/b1/c1/d1），周五有 2 节（a2/f1），周日没课
    const MON = new RealDate(2026, 8, 14), SUN = new RealDate(2026, 8, 20), FRI = new RealDate(2026, 8, 18);
    const T = boot(at(2026, 9, 14, 7, 0), makeDB());
    // 注意：boot 会把种子 mergeDeep 成一份新对象，要改就改 getDB() 返回的那份
    const D = T.getDB();

    ok('默认：周一有 4 节', T.dayCourses(MON).list.length === 4, T.dayCourses(MON).list.length);
    ok('默认：周一没停课', T.dayCourses(MON).off === false);
    ok('周日本来没课', T.rawCourses(SUN).length === 0);

    // ---- 禁用单日 ----
    D.days['2026-09-14'] = { off: true };
    ok('禁用后周一仍然列出课程（要渲染成请假样式）', T.dayCourses(MON).list.length === 4, T.dayCourses(MON).list.length);
    ok('禁用后 off 标记为真', T.dayCourses(MON).off === true);

    const plan = T.buildPlan();
    ok('禁用的那天不排任何提醒',
        Object.keys(plan).filter(k => k.indexOf('2026-09-14') >= 0).length === 0);
    ok('别的日子照常提醒',
        Object.keys(plan).filter(k => k.indexOf('2026-09-18') >= 0).length > 0);

    // ---- 调休的可选性 ----
    ok('有课的日子不能调休（要先禁用）', T.canSwap(FRI) === false);
    ok('没课的日子可以调休', T.canSwap(SUN) === true);
    ok('已禁用的日子也可以调休', T.canSwap(MON) === true);

    // ---- 把周一的课挪到周日 ----
    T.applySwap('2026-09-14', '2026-09-20');
    ok('源日（周一）变成停课', T.dayCourses(MON).off === true);
    const sun = T.dayCourses(SUN);
    ok('目标日（周日）显示源日的课', sun.list.length === 4 && sun.moved === true,
        JSON.stringify({ n: sun.list.length, moved: sun.moved }));
    ok('目标日不算停课', sun.off === false);
    ok('目标日拿到的确实是周一那几节',
        sun.list.map(x => x.id).sort().join(',') === 'a1,b1,c1,d1', sun.list.map(x => x.id).join(','));

    const plan2 = T.buildPlan();
    ok('调休后：课前提醒排到新的日期上',
        Object.keys(plan2).filter(k => k.indexOf('2026-09-20') >= 0).length > 0);
    ok('调休后：原日期不再有提醒',
        Object.keys(plan2).filter(k => k.indexOf('2026-09-14') >= 0).length === 0);

    // ---- 去掉调休标记，目标日回到原样 ----
    delete D.days['2026-09-20'];
    ok('取消调休标记后周日回到没课', T.dayCourses(SUN).list.length === 0, T.dayCourses(SUN).list.length);

    // ---- 一键禁用一段日期 ----
    const n = T.disableRange('2026-09-21', '2026-09-27');    // 第 4 周整整一周
    ok('一键禁用 7 天', n === 7, n);
    ok('重复禁用不会重复计数', T.disableRange('2026-09-21', '2026-09-27') === 0);
    const m4 = T.dayCourses(new RealDate(2026, 8, 21));      // 9/21 周一，第 4 周
    ok('假期里的日子停课了', m4.off === true && m4.list.length === 4,
        JSON.stringify({ off: m4.off, n: m4.list.length }));
    ok('日期写反了也能正确处理', T.disableRange('2026-09-30', '2026-09-29') === 2);

    // ---- 周末可见性：调休落到周末时要把周末露出来 ----
    const T2 = boot(at(2026, 9, 14, 7, 0), makeDB());
    ok('平时不显示周末', T2.visibleDays(3).indexOf(7) < 0, JSON.stringify(T2.visibleDays(3)));
    T2.getDB().days['2026-09-20'] = { from: '2026-09-14' };  // 第 3 周周日调休
    ok('有调休落到周末时显示周末', T2.visibleDays(3).indexOf(7) >= 0, JSON.stringify(T2.visibleDays(3)));
    ok('别的周不受影响', T2.visibleDays(4).indexOf(7) < 0, JSON.stringify(T2.visibleDays(4)));

    T.__restore(); T2.__restore();
}

console.log('\n=== 12. 渲染结果：表头、停课灰块、调休挪列 ===');
{
    const T = boot(at(2026, 9, 14, 9, 0), makeDB());   // 第 3 周
    const D = T.getDB();
    const cnt = (s, re) => (s.match(re) || []).length;
    // 取某一列上所有课块的 class（课块还可能是 blk tall leave，所以别写死）
    const clsOf = (s, dow) => {
        const re = new RegExp('class="(blk[^"]*)" data-id="[^"]*" data-week="\\d+" data-dow="' + dow + '"', 'g');
        const out = []; let m;
        while ((m = re.exec(s))) out.push(m[1]);
        return out;
    };

    // 表头：每格带 data-date，但结构必须和以前一模一样（不多任何元素）
    const head = T.html('kbDays');
    ok('表头 5 天都有 data-date', cnt(head, /data-date="/g) === 5, cnt(head, /data-date="/g));
    ok('表头没有多出按钮等元素', cnt(head, /<div/g) === 6 && head.indexOf('<button') < 0,
        cnt(head, /<div/g) + ' 个 div（1 个 spacer + 5 天）');
    ok('表头还是老结构', head.indexOf('<div class="kb-spacer"></div>') === 0 &&
        /kb-daycell[^>]*><b>一<\/b><span>\d+\/\d+<\/span>/.test(head.replace(/data-date="[^"]*" ?/g, '')));

    // 正常一周
    let b = T.html('kbBlocks');
    ok('周一渲染 4 个课块', cnt(b, /data-dow="1"/g) === 4, cnt(b, /data-dow="1"/g));
    ok('没有停课时不出现灰块', b.indexOf('"blk leave"') < 0);

    // 禁用周一
    D.days['2026-09-14'] = { off: true };
    T.refresh();
    b = T.html('kbBlocks');
    ok('禁用后周一 4 个课块全变灰',
        clsOf(b, 1).length === 4 && clsOf(b, 1).every(c => c.indexOf('leave') > 0),
        JSON.stringify(clsOf(b, 1)));
    ok('别的天没被牵连',
        clsOf(b, 5).length === 2 && clsOf(b, 5).every(c => c.indexOf('leave') < 0),
        JSON.stringify(clsOf(b, 5)));

    // 调休：周一的课挪到周日
    T.applySwap('2026-09-14', '2026-09-20');
    T.refresh();
    b = T.html('kbBlocks');
    ok('调休后周日那一列出现 4 个课块', cnt(b, /data-dow="7"/g) === 4, cnt(b, /data-dow="7"/g));
    ok('周一那列还在（停课的灰块）', cnt(b, /data-dow="1"/g) === 4);
    ok('调休到周末后表头多出周末两列', cnt(T.html('kbDays'), /data-date="/g) === 7,
        cnt(T.html('kbDays'), /data-date="/g));
    ok('调休挪过去的课块本身不是灰的',
        clsOf(b, 7).length === 4 && clsOf(b, 7).every(c => c.indexOf('leave') < 0),
        JSON.stringify(clsOf(b, 7)));

    ok('停课不删课块，只是变灰', cnt(b, /data-dow="1"/g) === 4);

    T.__restore();
}


console.log('\n=== 13. 每日提醒分段 / 通知带附件 / 消息只留当天 ===');
{
    // makeDB 周一：1-2、3-4（上午）5-6、7-8（下午）；再补一节晚上的
    const db = makeDB();
    db.entries.push({ id: 'n1', name: '计算机科学前沿技术', code: 'N1', day: 1, s: 9, e: 10,
        weeks: [3, 4], tag: 'none', teacher: '计算机老师', room: 'A1999' });
    const T = boot(at(2026, 9, 14, 6, 0), db);       // 周一早上 6 点
    const plan = T.buildPlan();
    const D = '2026-09-14';
    const g = i => plan['d' + D + '_' + i];

    ok('周一排了早/午/晚三条每日提醒', !!g(0) && !!g(1) && !!g(2),
        [!!g(0), !!g(1), !!g(2)].join(','));
    ok('早上那条列出全天 5 节', g(0) && g(0).body.split('\n').length === 5, g(0) && g(0).body.split('\n').length);
    ok('下午那条只列下午 2 节', g(1) && g(1).body.split('\n').length === 2, g(1) && g(1).body.split('\n').length);
    ok('下午那条不含上午的课', g(1) && g(1).body.indexOf('工科数学分析') < 0);
    ok('晚上那条只列晚上 1 节', g(2) && g(2).body.split('\n').length === 1, g(2) && g(2).body.split('\n').length);
    ok('晚上那条就是那门晚课', g(2) && g(2).body.indexOf('计算机科学前沿技术') > 0);
    ok('标题分早/午/晚', g(0).title.indexOf('今日课表') === 0 &&
        g(1).title.indexOf('今日下午') === 0 && g(2).title.indexOf('今日晚上') === 0,
        [g(0).title, g(1).title, g(2).title].join(' | '));

    // 周三（9/16）在 makeDB 里没课 → 三条都不该排
    const W = '2026-09-16';
    ok('整周没课的那天一条都不提醒',
        !plan['d' + W + '_0'] && !plan['d' + W + '_1'] && !plan['d' + W + '_2']);

    // 周五只有上午 1 节、下午 1 节 → 没有晚上那条
    const F = '2026-09-18';
    ok('周五有早/午、没有晚', !!plan['d' + F + '_0'] && !!plan['d' + F + '_1'] && !plan['d' + F + '_2'],
        [!!plan['d' + F + '_0'], !!plan['d' + F + '_1'], !!plan['d' + F + '_2']].join(','));

    T.__restore();
}
{
    // 课前提醒要带上备注的图片和文件
    const db = makeDB();
    const mk = () => ({
        note: '记得带报告',
        files: [
            { n: '报告模板.png', t: 'image/png', d: 'data:image/png;base64,AAAA', tn: 'data:image/jpeg;base64,BBBB' },
            { n: '讲义.pdf', t: 'application/pdf', d: 'data:application/pdf;base64,CCCC' }
        ]
    });
    db.marks = { 'a1@3': mk(), 'a1@4': mk(), 'b1@3': { note: '只有文字' } };
    const T = boot(at(2026, 9, 14, 6, 0), db);
    const plan = T.buildPlan();
    const ks = Object.keys(plan).filter(k => /^p.*_a1$/.test(k));
    ok('a1 有两条课前提醒（第 3、4 周各一条）', ks.length === 2, ks.length);
    ok('正文里列出了附件名',
        plan[ks[0]].body.indexOf('报告模板.png') > 0 && plan[ks[0]].body.indexOf('讲义.pdf') > 0,
        plan[ks[0]].body.split('\n').pop());
    ok('提醒上挂了图片 key', /^i/.test(plan[ks[0]].img || ''), plan[ks[0]].img);
    ok('没有图片的提醒不带 img', !plan[Object.keys(plan).filter(k => /^p.*_b1$/.test(k))[0]].img);
    const imgs = T.planImgs();
    ok('两条提醒共用同一张图，只存一份', ks.every(k => plan[k].img === plan[ks[0]].img) &&
        Object.keys(imgs).length === 1, JSON.stringify(Object.keys(imgs)));
    ok('存的是通知用的小图（tn）而不是原图',
        imgs[plan[ks[0]].img] === 'data:image/jpeg;base64,BBBB', imgs[plan[ks[0]].img]);
    T.__restore();
}
{
    // 消息中心只留当天
    const db = makeDB();
    db.msgs = {
        yest: { at: new RealDate(2026, 8, 13, 10, 0).getTime(), title: '昨天', body: 'x', kind: 'daily', read: true },
        today: { at: new RealDate(2026, 8, 14, 10, 0).getTime(), title: '今天', body: 'y', kind: 'daily', read: false }
    };
    const T = boot(at(2026, 9, 14, 12, 0), db);
    T.syncMsgs({});
    const ks = Object.keys(T.getDB().msgs);
    ok('昨天的消息被清掉', ks.indexOf('yest') < 0, ks.join(','));
    ok('今天的还在', ks.indexOf('today') >= 0);

    // 从课前提醒的 key 反查那节课的附件
    const db2 = makeDB();
    db2.marks = { 'a1@3': { files: [{ n: 'x.png', t: 'image/png', d: 'data:image/png;base64,AAA' }] } };
    const T2 = boot(at(2026, 9, 14, 12, 0), db2);
    ok('消息 key → 能查到那次课的附件',
        T2.msgFiles('p2026-09-14_a1').length === 1, JSON.stringify(T2.msgFiles('p2026-09-14_a1')));
    ok('每日提醒的 key 查不到附件', T2.msgFiles('d2026-09-14_0').length === 0);

    T.__restore(); T2.__restore();
}

console.log('\n=== 14. 每日运势 ===');
{
    // 用可控的 Math.random 验证级别与细分的边界
    function withRandom(seq, fn) {
        const real = Math.random;
        let i = 0;
        Math.random = () => seq[Math.min(i++, seq.length - 1)];
        try { return fn(); } finally { Math.random = real; }
    }

    const T = boot(at(2026, 9, 16, 10, 0), makeDB());   // 2026-09-16 周三
    const K = n => T.FORTUNE_KIND[n];

    // (a) 级别概率的边界：20% 凶 / 35% 平 / 45% 吉
    [[0.00, 'xiong'], [0.199, 'xiong'], [0.201, 'ping'], [0.549, 'ping'], [0.551, 'ji'], [0.999, 'ji']]
        .forEach(([r, want]) => {
            const got = K(withRandom([r, 0.5], () => T.pickFortune(false)));
            ok('r=' + r + ' → ' + want, got === want, got);
        });

    // (b) 平的细分：大平/中平/小平 各 30%，一平如洗 10%
    const pingR = r => withRandom([0.3, r], () => T.pickFortune(false));
    ok('平 r=0.29 → 大平', pingR(0.29) === '大平');
    ok('平 r=0.31 → 中平', pingR(0.31) === '中平');
    ok('平 r=0.61 → 小平', pingR(0.61) === '小平');
    ok('平 r=0.91 → 一平如洗', pingR(0.91) === '一平如洗');

    // (c) 吉的细分：大/中/小吉 各 30%，剩下 10% 三等分给三个彩蛋
    const jiR = r => withRandom([0.8, r], () => T.pickFortune(false));
    ok('吉 r=0.29 → 大吉', jiR(0.29) === '大吉');
    ok('吉 r=0.61 → 小吉', jiR(0.61) === '小吉');
    ok('吉 r=0.91 → 桃花运', jiR(0.91) === '桃花运');
    ok('吉 r=0.95 → 天选之子', jiR(0.95) === '天选之子');
    ok('吉 r=0.98 → 王马小吉', jiR(0.98) === '王马小吉');

    // (d) 昨天中过凶：今天一定不出凶（平/吉 按 35:45 归一，界在 0.4375）
    [0.0, 0.2, 0.43, 0.44, 0.9, 0.999].forEach(r => {
        const got = K(withRandom([r, 0.5], () => T.pickFortune(true)));
        ok('昨天凶时 r=' + r + ' 不出凶', got !== 'xiong', got);
    });
    ok('昨天凶时 r=0.43 → 平', K(withRandom([0.43, 0.5], () => T.pickFortune(true))) === 'ping');
    ok('昨天凶时 r=0.45 → 吉', K(withRandom([0.45, 0.5], () => T.pickFortune(true))) === 'ji');

    // (e) 整体分布（跑 4000 次看大数）
    let c = { xiong: 0, ping: 0, ji: 0 };
    for (let i = 0; i < 4000; i++) c[K(T.pickFortune(false))]++;
    ok('凶 ≈ 20%', Math.abs(c.xiong / 4000 - 0.20) < 0.03, (c.xiong / 40).toFixed(1) + '%');
    ok('平 ≈ 35%', Math.abs(c.ping / 4000 - 0.35) < 0.035, (c.ping / 40).toFixed(1) + '%');
    ok('吉 ≈ 45%', Math.abs(c.ji / 4000 - 0.45) < 0.035, (c.ji / 40).toFixed(1) + '%');
    T.__restore();
}
{
    // 连续 / 断签
    const d1 = makeDB();
    d1.fortune = { log: { '2026-09-14': '大吉', '2026-09-15': '中平' } };
    const T1 = boot(at(2026, 9, 16, 10, 0), d1);
    ok('抽之前连续 2 天', T1.fortuneStreak() === 2, T1.fortuneStreak());
    ok('drawFortune 返回 true 表示这次真的抽了', T1.drawFortune() === true);
    ok('抽完连续 3 天', T1.fortuneStreak() === 3, T1.fortuneStreak());
    const first = T1.fortuneLog()['2026-09-16'];
    ok('同一天再抽不会变', T1.drawFortune() === false && T1.fortuneLog()['2026-09-16'] === first, first);

    // 昨天没抽 → 断签，旧的清空
    const d2 = makeDB();
    d2.fortune = { log: { '2026-09-10': '大吉', '2026-09-11': '大吉', '2026-09-12': '小吉' } };
    const T2 = boot(at(2026, 9, 16, 10, 0), d2);
    T2.drawFortune();
    const ks = Object.keys(T2.fortuneLog());
    ok('断签后旧记录被清空，只剩今天', ks.length === 1 && ks[0] === '2026-09-16', ks.join(','));
    ok('断签后连续天数回到 1', T2.fortuneStreak() === 1, T2.fortuneStreak());
    T1.__restore(); T2.__restore();
}
{
    // 次数统计：没抽到过的不显示（界面按 >0 过滤）
    const d = makeDB();
    d.fortune = { log: { '2026-09-16': '大吉', '2026-09-15': '大吉', '2026-09-14': '一平如洗' } };
    const T = boot(at(2026, 9, 16, 10, 0), d);
    const c = T.fortuneCounts();
    ok('大吉 ×2', c['大吉'] === 2, c['大吉']);
    ok('一平如洗 ×1', c['一平如洗'] === 1);
    ok('没抽到过的都是 0', c['大凶'] === 0 && c['天选之子'] === 0 && c['王马小吉'] === 0);
    ok('统计表覆盖全部 13 种运势', Object.keys(c).length === 13, Object.keys(c).length);
    ok('趋势按日期倒序', T.fortuneDays()[0] === '2026-09-16', T.fortuneDays().join(','));
    T.__restore();
}

console.log('\n=== 15. 运势弹层渲染 ===');
{
    // 造 9 天连续记录（都是今天往回数），今天是大吉
    const names = ['大吉', '大吉', '中平', '小凶', '一平如洗', '桃花运', '大吉', '中吉', '小吉'];
    const log = {};
    const ds = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
    names.forEach((n, i) => { log[ds(new RealDate(2026, 8, 16 - i))] = n; });
    const db = makeDB();
    db.fortune = { log: log };
    const T = boot(at(2026, 9, 16, 10, 0), db);
    T.drawFortuneSheet();
    let h = T.html('sheetBody');

    ok('主角显示今天抽中的大吉', h.indexOf('ft-name ft-ji') > 0 && h.indexOf('>大吉<') > 0);
    ok('显示连续 9 天', h.indexOf('已连续抽运 <b>9</b> 天') > 0);
    ok('默认只列最近 7 天', (h.match(/class="ft-row"/g) || []).length === 7,
        (h.match(/class="ft-row"/g) || []).length);
    ok('有「查看全部趋势」按钮', h.indexOf('查看全部趋势（共 9 天）') > 0);
    ok('抽到过的大吉显示 ×3', h.indexOf('大吉 ×3') > 0);
    ok('没抽到过的运势隐藏', h.indexOf('大凶') < 0 && h.indexOf('王马小吉') < 0 && h.indexOf('天选之子') < 0);
    ok('吉是金色、凶是灰色', h.indexOf('ft-val ft-ji') > 0 && h.indexOf('ft-val ft-xiong') > 0);

    T.setFortuneAll(true);
    T.drawFortuneSheet();
    h = T.html('sheetBody');
    ok('切到全部趋势列出 9 行', (h.match(/class="ft-row"/g) || []).length === 9,
        (h.match(/class="ft-row"/g) || []).length);
    ok('全部趋势里有「只看最近 7 天」', h.indexOf('只看最近 7 天') > 0);
    T.__restore();
}
{
    // 凶的小字：平时「日行一善」，周四「vivo50」
    const d1 = makeDB();
    d1.fortune = { log: { '2026-09-16': '小凶' } };        // 2026-09-16 是周三
    const T1 = boot(at(2026, 9, 16, 10, 0), d1);
    T1.drawFortuneSheet();
    const h1 = T1.html('sheetBody');
    ok('周三中凶显示「日行一善即可消灾」', h1.indexOf('日行一善即可消灾') > 0);
    ok('周三不显示 vivo50', h1.indexOf('vivo50') < 0);

    const d2 = makeDB();
    d2.fortune = { log: { '2026-09-17': '大凶' } };        // 2026-09-17 是周四
    const T2 = boot(at(2026, 9, 17, 10, 0), d2);
    T2.drawFortuneSheet();
    const h2 = T2.html('sheetBody');
    ok('周四中凶显示「vivo50即可消灾」', h2.indexOf('vivo50即可消灾') > 0);
    ok('周四不再显示「日行一善」', h2.indexOf('日行一善') < 0);

    // 平/吉不该有小字
    const d3 = makeDB();
    d3.fortune = { log: { '2026-09-16': '中平' } };
    const T3 = boot(at(2026, 9, 16, 10, 0), d3);
    T3.drawFortuneSheet();
    const h3 = T3.html('sheetBody');
    ok('平没有消灾小字', h3.indexOf('消灾') < 0);

    T1.__restore(); T2.__restore(); T3.__restore();
}

console.log('\n=== 16. 提醒事项：通知计划 ===');
{
    const db = makeDB();
    db.todos = [
        { id: 'T1', name: '交实验报告', mode: 'date', date: '2026-09-14', days: [],
          time: '13:00', desc: '记得带纸质版', files: [
            { n: '报告.png', t: 'image/png', d: 'data:image/png;base64,AAAA', tn: 'data:image/jpeg;base64,BBBB' },
            { n: '要求.pdf', t: 'application/pdf', d: 'data:application/pdf;base64,CCCC' }] },
        { id: 'T2', name: '还书', mode: 'date', date: '2026-09-15', days: [], time: '', desc: '', files: [] },
        { id: 'T3', name: '每周例会', mode: 'week', date: '', days: [1, 3], time: '09:30', desc: '', files: [] }
    ];
    const T = boot(at(2026, 9, 14, 6, 0), db);       // 周一早上 6 点
    const plan = T.buildPlan();

    const k1 = 't2026-09-14_T1';
    ok('日期+时间：按时排到了计划里', !!plan[k1] && plan[k1].at === at(2026, 9, 14, 13, 0),
        plan[k1] && new RealDate(plan[k1].at).toTimeString().slice(0, 5));
    ok('标题带铃铛和事项名', plan[k1].title === '🔔 交实验报告', plan[k1].title);
    ok('正文含描述', plan[k1].body.indexOf('记得带纸质版') >= 0, JSON.stringify(plan[k1].body));
    ok('正文列出附件名', plan[k1].body.indexOf('报告.png') > 0 && plan[k1].body.indexOf('要求.pdf') > 0,
        plan[k1].body.split('\n').pop());
    ok('挂了通知大图的 key', /^i/.test(plan[k1].img || ''), plan[k1].img);
    ok('图片用的是缩略图 tn', T.planImgs()[plan[k1].img] === 'data:image/jpeg;base64,BBBB');

    const k2 = 't2026-09-15_T2';
    ok('只填日期：跟早课表同一时刻（08:00）', !!plan[k2] && plan[k2].at === at(2026, 9, 15, 8, 0),
        plan[k2] && new RealDate(plan[k2].at).toTimeString().slice(0, 5));
    ok('没描述时给个兜底正文', plan[k2].body === '到点啦', plan[k2].body);

    const wk = Object.keys(plan).filter(k => /^t.*_T3$/.test(k)).sort();
    ok('每周一三：21 天里排到了该有的次数', wk.length === 6, wk.join(','));
    ok('每周那条只落在周一和周三',
        wk.every(k => [1, 3].indexOf(new RealDate(k.slice(1, 11).replace(/-/g, '/')).getDay()) >= 0),
        wk.join(','));
    ok('每周那条的时间是 09:30',
        wk.every(k => new RealDate(plan[k].at).getHours() === 9 && new RealDate(plan[k].at).getMinutes() === 30));
    T.__restore();
}
{
    // 停课的日子：课程提醒不发，但提醒事项照发
    const db = makeDB();
    db.days = { '2026-09-14': { off: true } };
    db.todos = [{ id: 'T1', name: '交表', mode: 'date', date: '2026-09-14', days: [], time: '10:00', desc: '', files: [] }];
    const T = boot(at(2026, 9, 14, 6, 0), db);
    const plan = T.buildPlan();
    ok('停课那天不推课程提醒', !Object.keys(plan).some(k => k[0] === 'p' && k.indexOf('2026-09-14') > 0));
    ok('停课但有提醒事项 → 照样提醒', !!plan['t2026-09-14_T1']);
    T.__restore();
}
{
    // 从消息 key 反查提醒事项的附件
    const db = makeDB();
    db.todos = [{ id: 'T1', name: '交报告', mode: 'date', date: '2026-09-14', days: [], time: '10:00',
        desc: '', files: [{ n: 'x.png', t: 'image/png', d: 'data:image/png;base64,AAA' }] }];
    const T = boot(at(2026, 9, 14, 6, 0), db);
    ok('消息 key → 查得到提醒事项的附件', T.msgFiles('t2026-09-14_T1').length === 1,
        JSON.stringify(T.msgFiles('t2026-09-14_T1').map ? T.msgFiles('t2026-09-14_T1').map(f => f.n) : null));
    ok('别的 key 查不到', T.msgFiles('d2026-09-14_0').length === 0);
    T.__restore();
}

console.log('\n=== 17. 提醒事项：课表上的标记 ===');
{
    const db = makeDB();
    db.todos = [
        { id: 'A', name: '只有日期', mode: 'date', date: '2026-09-14', days: [], time: '', desc: '', files: [] },
        { id: 'B', name: '那点有课', mode: 'date', date: '2026-09-14', days: [], time: '09:00', desc: '', files: [] },
        { id: 'C', name: '那点没课', mode: 'date', date: '2026-09-14', days: [], time: '13:00', desc: '', files: [] }
    ];
    const T = boot(at(2026, 9, 14, 6, 0), db);
    T.refresh();
    const head = T.html('kbDays'), body = T.html('kbBlocks');
    const cnt = (s, re) => (s.match(re) || []).length;

    ok('只有日期 → 表头出现小铃铛', cnt(head, /class="kb-todo"/g) === 1, cnt(head, /class="kb-todo"/g));
    ok('铃铛只在周一那一格',
        /data-date="2026-09-14">\s*<i class="kb-todo"/.test(head.replace(/\n/g, '')) === false ?
        head.indexOf('kb-todo') < head.indexOf('2026-09-15') : true);

    ok('那一刻有课 → 课块挂上 🔔', /class="bmark">🔔/.test(body), (body.match(/class="bmark">[^<]*/g) || []).join(' | '));
    ok('那一刻没课 → 画了一条小标', cnt(body, /class="kb-todochip"/g) === 1, cnt(body, /class="kb-todochip"/g));
    ok('小标上写着时间和小事项名', /class="kb-todochip"[^>]*>🔔 13:00 那点没课</.test(body),
        (body.match(/class="kb-todochip"[^>]*>([^<]*)/) || [])[1]);
    ok('有课那条不再另外画小标', body.indexOf('09:00 那点有课') < 0);
    T.__restore();
}
{
    // 每周固定的提醒：每一周都要能匹配上
    const db = makeDB();
    db.todos = [{ id: 'W', name: '周三晚自习', mode: 'week', date: '', days: [3], time: '', desc: '', files: [] }];
    const T = boot(at(2026, 9, 14, 6, 0), db);
    T.refresh();
    ok('每周三 → 表头周三那格有铃铛',
        /data-date="2026-09-16">\s*<i class="kb-todo"/.test(T.html('kbDays').replace(/\n/g, '')) ||
        T.html('kbDays').indexOf('kb-todo') > 0);
    T.__restore();
}

console.log('\n' + (fails ? '✗ ' + fails + ' 项失败' : '✓ 全部通过') + '\n');
process.exit(fails ? 1 : 0);
