// 生成一份用于界面预览的 DB 种子数据。
// 优先用真实 PDF 解析；PDF 不在时退回 tools/seed-static.js 里的固定数据。
const fs = require('fs');
const path = require('path');
const KBPdf = require(path.join(__dirname, '..', 'app', 'assets', 'www', 'kbpdf.js'));

const PALETTE_N = 8;
const pdf = process.argv[2] || path.join(__dirname, '..', '..', '王泽楷(2026-2027-1)课表.pdf');
const out = process.argv[3] || path.join(__dirname, '..', 'build', 'seed.json');

function sampleMarks(entries) {
    const W = 15;
    const marks = {};
    if (entries[0]) marks[entries[0].id + '@' + W] = { note: '带实验报告，记得交' };
    if (entries[2]) marks[entries[2].id + '@' + W] = { leave: true };
    if (entries[3]) marks[entries[3].id + '@' + W] = { sign: true };
    if (entries[5]) marks[entries[5].id + '@' + W] = { note: '小测，复习第三章' };
    return marks;
}

function writeDB(entries, meta) {
    const db = {
        v: 1,
        meta: {
            student: meta.student || '', sid: meta.sid || '', term: meta.term || '',
            firstWeekMonday: '2026-08-31'
        },
        entries: entries,
        marks: sampleMarks(entries),
        settings: {
            dailyOn: true, dailyTimes: ['08:00', '12:30'], dailyWhenEmpty: false,
            preOn: true, preMin: 10, notifyNormal: true, notifyEasy: false,
            signOn: false, periods: 11, totalWeeks: 20, timetable: 'dxc', weekend: 'auto'
        }
    };
    fs.writeFileSync(out, JSON.stringify(db));
    console.log('entries:', entries.length, '->', out, fs.statSync(out).size, 'bytes');
}

if (!fs.existsSync(pdf)) {
    const S = require('./seed-static.js');
    console.log('未找到课表 PDF，使用固定演示数据');
    writeDB(S.entries, S.meta);
} else {
    KBPdf.parseBytes(new Uint8Array(fs.readFileSync(pdf))).then(res => {
        const entries = res.entries.map((e, i) => ({
            id: 'e' + (i + 100),
            name: e.name,
            code: e.code || '',
            teacher: e.teacher || '',
            room: e.room || '',
            campus: e.campus || '',
            day: e.day + 1,
            s: e.s, e: e.e,
            weeks: e.weeks || [],
            weekText: e.weekText || '',
            cls: e.cls || '',
            credits: e.credits || 0,
            color: i % PALETTE_N,
            tag: i === 0 ? 'important' : (i === 1 ? 'easy' : 'none')
        })).filter(e => e.weeks.length);
        writeDB(entries, res.meta);
    });
}
