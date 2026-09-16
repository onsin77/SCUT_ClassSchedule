/* 一次性诊断：把 buildPlan 的结果 dump 出来，找重复与内容不符
   用法：node tools/diag-plan.js
*/
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'app/assets/www/app.js'), 'utf8');
const RealDate = Date;

function fakeEl() {
    const o = { style: {}, dataset: {}, hidden: false, innerHTML: '', textContent: '', value: '',
        scrollTop: 0, scrollHeight: 100, offsetHeight: 800, offsetWidth: 400,
        classList: { add() { }, remove() { }, toggle() { }, contains() { return false; } } };
    ['addEventListener', 'removeEventListener', 'appendChild', 'removeChild', 'setAttribute',
        'toggleAttribute', 'focus', 'setSelectionRange', 'click', 'dispatchEvent'].forEach(k => { o[k] = () => { }; });
    o.querySelector = () => fakeEl(); o.querySelectorAll = () => []; o.closest = () => null;
    o.getAttribute = () => null; o.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 800 });
    return o;
}

function boot(nowMs, seedDb) {
    class FakeDate extends RealDate {
        constructor(...a) { if (a.length === 0) super(nowMs); else super(...a); }
        static now() { return nowMs; }
    }
    global.window = {};
    global.Date = FakeDate;
    global.document = { readyState: 'complete', getElementById: () => fakeEl(), querySelector: () => fakeEl(),
        querySelectorAll: () => [], createElement: () => fakeEl(), addEventListener: () => { }, body: fakeEl() };
    global.localStorage = { getItem: () => (seedDb ? JSON.stringify(seedDb) : null), setItem: () => { }, removeItem: () => { } };
    global.setInterval = () => 0; global.setTimeout = () => 0; global.confirm = () => false; global.alert = () => { };
    const cut = SRC.lastIndexOf('})();');
    (0, eval)(SRC.slice(0, cut) + `
        window.__T = { buildPlan: buildPlan, weekOf: weekOf, ymd: ymd, getDB: function(){ return DB; },
                       entryOccursInWeek: entryOccursInWeek, periodTime: periodTime };
    ` + SRC.slice(cut));
    return global.window.__T;
}

// 用真实课表 PDF 解析出来的数据
const KBPdf = require(path.join(__dirname, '..', 'app/assets/www/kbpdf.js'));
const pdfPath = path.join(__dirname, '..', '..', '王泽楷(2026-2027-1)课表.pdf');

KBPdf.parseBytes(new Uint8Array(fs.readFileSync(pdfPath))).then(res => {
    const entries = res.entries.map((e, i) => ({
        id: 'e' + (100 + i), name: e.name, code: e.code || '', teacher: e.teacher || '',
        room: e.room || '', campus: e.campus || '', day: e.day + 1, s: e.s, e: e.e,
        weeks: e.weeks || [], weekText: e.weekText || '', cls: e.cls || '', credits: e.credits || 0, tag: 'none'
    })).filter(e => e.weeks.length);
    const db = {
        v: 1, meta: { student: '', sid: '', term: '', firstWeekMonday: '2026-08-31' },
        colors: {}, marks: {}, msgs: {}, entries: entries,
        settings: { dailyOn: true, dailyTimes: ['08:00', '12:30'], dailyWhenEmpty: false, preOn: true,
            preMin: 10, notifyNormal: true, notifyEasy: false, signOn: false, periods: 11,
            totalWeeks: 20, timetable: 'dxc', weekend: 'auto' }
    };

    // 从「今天」起算（2026-09-16 周三）
    const now = new RealDate(2026, 8, 16, 9, 0, 0).getTime();
    const T = boot(now, db);
    const plan = T.buildPlan();
    const keys = Object.keys(plan);
    console.log('条目数:', keys.length, '| 当前周:', T.weekOf(new RealDate(now)));

    // 1) 键是否唯一（对象天然唯一，这里查"内容+时间"重复）
    const seen = new Map();
    const dup = [];
    keys.forEach(k => {
        const p = plan[k];
        const sig = p.at + '|' + p.title + '|' + p.body;
        if (seen.has(sig)) dup.push([seen.get(sig), k, p.title]);
        else seen.set(sig, k);
    });
    console.log('\n[1] 同一时刻+同一内容的重复条目:', dup.length);
    dup.slice(0, 8).forEach(d => console.log('   ', d[0], '<->', d[1], '|', d[2]));

    // 2) 每条课前提醒的"老师"是否真的在本周上这门课
    const bad = [];
    keys.filter(k => k[0] === 'p').forEach(k => {
        const p = plan[k];
        const name = p.title.split('· ')[1];
        // 从 key 里还原日期与 entry id
        const m = k.match(/^p(\d{4}-\d{2}-\d{2})_(\d+)_(.+)$/);
        const dstr = m[1], id = m[3];
        const d = new RealDate(+dstr.slice(0, 4), +dstr.slice(5, 7) - 1, +dstr.slice(8, 10));
        const w = T.weekOf(d);
        const dows = ['', 1, 2, 3, 4, 5, 6, 7];
        const e = db.entries.find(x => x.id === id);
        if (!e) { bad.push([k, '找不到条目']); return; }
        if (!T.entryOccursInWeek(e, w)) bad.push([k, name, '本周(' + w + ')不上这门课', e.name]);
        const bodyTeacher = (p.body.match(/👤 (.+)/) || [])[1];
        if (bodyTeacher && bodyTeacher !== e.teacher) bad.push([k, '老师不符', bodyTeacher, e.teacher]);
        if (!p.body.includes(e.room)) bad.push([k, '地点不符', e.room, p.body.split('\n').join(' / ')]);
    });
    console.log('\n[2] 内容与本周不符的提醒:', bad.length);
    bad.slice(0, 10).forEach(b => console.log('   ', b.join(' | ')));

    // 3) 同一门课同一天被排了两次？
    const byDayCourse = {};
    keys.filter(k => k[0] === 'p').forEach(k => {
        const m = k.match(/^p(\d{4}-\d{2}-\d{2})_(\d+)_(.+)$/);
        const e = db.entries.find(x => x.id === m[3]);
        if (!e) return;
        const key = m[1] + '#' + e.name;
        (byDayCourse[key] = byDayCourse[key] || []).push(k);
    });
    const twice = Object.keys(byDayCourse).filter(k => byDayCourse[k].length > 1);
    console.log('\n[3] 同一天同一门课被排多次:', twice.length);
    twice.slice(0, 10).forEach(k => console.log('   ', k, '->', byDayCourse[k].map(x => plan[x].title).join(' || ')));

    // 4) 每日课表重复
    const daily = keys.filter(k => k[0] === 'd');
    const dailyDup = [];
    const dm = {};
    daily.forEach(k => {
        const m = k.match(/^d(\d{4}-\d{2}-\d{2})_(\d)$/);
        (dm[m[1]] = dm[m[1]] || []).push(k);
    });
    Object.keys(dm).forEach(d => {
        const sigs = dm[d].map(k => plan[k].at);
        if (new Set(sigs).size !== sigs.length) dailyDup.push(d);
    });
    console.log('\n[4] 同一天有两条每日课表撞同一时刻:', dailyDup.length, dailyDup.slice(0, 5));
    console.log('    每日课表时段设置:', JSON.stringify(db.settings.dailyTimes));
});
