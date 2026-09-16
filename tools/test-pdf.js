// 用真实 PDF 验证 kbpdf.js 的解析结果
const fs = require('fs');
const path = require('path');
const KBPdf = require(path.join(__dirname, '..', 'app', 'assets', 'www', 'kbpdf.js'));

const file = process.argv[2] || path.join(__dirname, '..', '..', '王泽楷(2026-2027-1)课表.pdf');
const bytes = new Uint8Array(fs.readFileSync(file));
const DAY = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

KBPdf.parseBytes(bytes).then(r => {
    console.log('=== meta ===');
    console.log(JSON.stringify(r.meta, null, 1));
    console.log('=== 共 ' + r.entries.length + ' 条 ===');
    r.entries.forEach(e => {
        console.log(
            DAY[e.day + 1] + ' 第' + e.s + '-' + e.e + '节  ' +
            e.name + '  [' + e.code + ']  ' +
            '周次{' + e.weekText + '} → ' + e.weeks.length + '周  ' +
            e.campus + ' ' + e.room + '  ' + e.teacher + '  ' + e.credits + '学分'
        );
    });
    // 一致性校验
    const total = r.entries.length;
    const bad = r.entries.filter(e => !e.name || !e.weeks.length);
    console.log('=== 校验 ===');
    console.log('条目数', total, '| 异常条目', bad.length);
    bad.forEach(e => console.log('  异常:', JSON.stringify(e)));
}).catch(e => {
    console.error('FAILED:', e);
    process.exit(1);
});
