// 调试：打印各页 y>495 的文本项（表头区域），用于定位表头元素坐标
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'assets', 'www', 'kbpdf.js'), 'utf8');
const mod = src.replace('global.KBPdf = {',
    'global.KBPdf = { _scanText: scanText, _parseObjects: parseObjects, _contentStreams: contentStreams, _toLatin1: toLatin1, _zlibInflate: zlibInflate,');
new Function('module', 'globalThis', mod + '\n;module.exports=globalThis.KBPdf;')({ exports: {} }, globalThis);
const KB = globalThis.KBPdf;

const bytes = new Uint8Array(fs.readFileSync(process.argv[2]));
const latin = KB._toLatin1(bytes);
const objs = KB._parseObjects(latin);
const refs = KB._contentStreams(objs, latin);
refs.forEach((num, pi) => {
    const o = objs[num];
    const raw = new Uint8Array(o.stream.length);
    for (let i = 0; i < o.stream.length; i++) raw[i] = o.stream.charCodeAt(i) & 0xff;
    KB._zlibInflate(raw).then(u8 => {
        const items = KB._scanText(KB._toLatin1(u8));
        console.log('=== page', pi + 1, 'items', items.length, ' y范围',
            Math.min(...items.map(i => i.y)).toFixed(1), '~', Math.max(...items.map(i => i.y)).toFixed(1));
        items.filter(it => it.y > 495).sort((a, b) => (b.y - a.y) || (a.x - b.x))
            .forEach(it => console.log('   y=' + it.y + ' x=' + it.x + '  ' + JSON.stringify(it.t)));
    });
});
