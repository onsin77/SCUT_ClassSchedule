/*
 * 华工课程表 —— 正方教务「学生个人课表」PDF 解析
 *
 * 该 PDF 由 iText 生成，字体为 STSong-Light + UniGB-UCS2-H，
 * 因此文本字符串本身就是 UTF-16BE 编码，不需要字体映射表即可还原中文。
 * 版式固定：横向表格，列为「时间段 | 节次 | 星期一 .. 星期日」。
 * 解析思路：
 *   1. 取出每个页面的内容流，解 FlateDecode；
 *   2. 扫描 BT..ET 中的 Tm / Tj，得到「坐标 + 文本」；
 *   3. 用表头「星期一..星期日」的 x 坐标定出 7 个日列；
 *   4. 按页序、列内按 y 从大到小拼接该列全部文本；
 *   5. 用「(N-M节)」切段，段间以「学分:x」为界，段前的残留即为下一门课名。
 */
(function (global) {
    'use strict';

    // ---------------------------------------------------------------- 工具

    function toLatin1(u8) {
        var s = '', CH = 0x8000;
        for (var i = 0; i < u8.length; i += CH) {
            s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CH, u8.length)));
        }
        return s;
    }

    function isWS(c) {
        return c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0';
    }

    // 读 PDF 字面量字符串 ( ... )，处理转义与嵌套括号
    function readLit(s, start) {
        var i = start + 1, depth = 1, out = '';
        while (i < s.length && depth > 0) {
            var c = s[i];
            if (c === '\\') {
                var n = s[i + 1];
                if (n >= '0' && n <= '7') {
                    var oct = '';
                    var k = i + 1;
                    while (k < s.length && oct.length < 3 && s[k] >= '0' && s[k] <= '7') {
                        oct += s[k]; k++;
                    }
                    out += String.fromCharCode(parseInt(oct, 8) & 0xff);
                    i = k;
                    continue;
                }
                var map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
                out += (n in map) ? map[n] : (n === undefined ? '' : n);
                i += 2;
                continue;
            }
            if (c === '(') depth++;
            else if (c === ')') { depth--; if (depth === 0) { i++; break; } }
            out += c;
            i++;
        }
        return { v: out, next: i };
    }

    function hexStr(h) {
        var clean = h.replace(/[^0-9A-Fa-f]/g, '');
        if (clean.length % 2) clean += '0';
        var out = '';
        for (var i = 0; i < clean.length; i += 2) {
            out += String.fromCharCode(parseInt(clean.substr(i, 2), 16));
        }
        return out;
    }

    // latin1 字符串（每字符一个字节）→ UTF-16BE 文本
    function utf16be(latin) {
        var out = '';
        for (var i = 0; i + 1 < latin.length; i += 2) {
            out += String.fromCharCode((latin.charCodeAt(i) << 8) | latin.charCodeAt(i + 1));
        }
        return out;
    }

    // ---------------------------------------------------------------- 解压

    function zlibInflate(u8) {
        // 优先用浏览器原生 DecompressionStream
        if (typeof DecompressionStream === 'function' && typeof Blob === 'function') {
            try {
                var stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate'));
                return new Response(stream).arrayBuffer().then(function (buf) {
                    return new Uint8Array(buf);
                }).catch(function () {
                    return inflateRaw(u8);   // 原生解压失败时退回纯 JS 实现
                });
            } catch (e) {
                return Promise.resolve(inflateRaw(u8));
            }
        }
        return Promise.resolve(inflateRaw(u8));
    }

    // 纯 JS 兜底：跳过 zlib 2 字节头，调用 raw inflate
    function inflateRaw(u8) {
        if (u8.length > 2 && (u8[0] & 0x0f) === 8) u8 = u8.subarray(2);
        var pos = 0, bitPos = 0;
        function bits(n) {
            var v = 0;
            for (var i = 0; i < n; i++) {
                if (pos >= u8.length) break;
                v |= ((u8[pos] >> bitPos) & 1) << i;
                bitPos++;
                if (bitPos === 8) { bitPos = 0; pos++; }
            }
            return v;
        }
        function build(lengths) {
            var maxLen = 0, i, code;
            for (i = 0; i < lengths.length; i++) if (lengths[i] > maxLen) maxLen = lengths[i];
            var blCount = new Array(maxLen + 1).fill(0);
            for (i = 0; i < lengths.length; i++) if (lengths[i]) blCount[lengths[i]]++;
            var nextCode = new Array(maxLen + 1).fill(0);
            var c = 0;
            for (i = 1; i <= maxLen; i++) { c = (c + blCount[i - 1]) << 1; nextCode[i] = c; }
            var table = {};
            for (i = 0; i < lengths.length; i++) {
                var len = lengths[i];
                if (!len) continue;
                code = nextCode[len]++;
                var key = len + ':' + code;
                table[key] = i;
            }
            return { table: table, maxLen: maxLen };
        }
        function decode(huff) {
            var code = 0;
            for (var len = 1; len <= huff.maxLen; len++) {
                code |= bits(1) << (len - 1);
                var v = huff.table[len + ':' + code];
                if (v !== undefined) return v;
            }
            throw new Error('inflate: bad code');
        }
        var LB = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
        var LE = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
        var DB = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
        var DE = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
        var out = [];
        for (;;) {
            var last = bits(1), type = bits(2);
            if (type === 0) {
                if (bitPos) { bitPos = 0; pos++; }
                var len0 = u8[pos] | (u8[pos + 1] << 8); pos += 4;
                for (var j = 0; j < len0; j++) out.push(u8[pos++]);
            } else if (type === 1 || type === 2) {
                var lit, dist, lc, dc;
                if (type === 1) {
                    lc = build(new Array(288).fill(0).map(function (_, i) { return i < 144 ? 8 : (i < 256 ? 9 : (i < 280 ? 7 : 8)); }));
                    dc = build(new Array(30).fill(5));
                } else {
                    var hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
                    var order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
                    var clen = new Array(19).fill(0);
                    for (var q = 0; q < hclen; q++) clen[order[q]] = bits(3);
                    var ch = build(clen);
                    var lens = [];
                    while (lens.length < hlit + hdist) {
                        var sym = decode(ch);
                        if (sym < 16) lens.push(sym);
                        else if (sym === 16) { var r = bits(2) + 3, p = lens[lens.length - 1]; while (r--) lens.push(p); }
                        else if (sym === 17) { var r2 = bits(3) + 3; while (r2--) lens.push(0); }
                        else { var r3 = bits(7) + 11; while (r3--) lens.push(0); }
                    }
                    lc = build(lens.slice(0, hlit));
                    dc = build(lens.slice(hlit));
                }
                for (;;) {
                    var s = decode(lc);
                    if (s < 256) out.push(s);
                    else if (s === 256) break;
                    else {
                        s -= 257;
                        var l = LB[s] + bits(LE[s]);
                        var d = decode(dc);
                        var dd = DB[d] + bits(DE[d]);
                        for (var t = 0; t < l; t++) out.push(out[out.length - dd]);
                    }
                }
            } else {
                throw new Error('inflate: invalid block');
            }
            if (last) break;
        }
        return new Uint8Array(out);
    }

    // ---------------------------------------------------------------- PDF 结构

    function parseObjects(latin) {
        var objs = {};
        var re = /(\d+)\s+(\d+)\s+obj\b/g, m;
        while ((m = re.exec(latin))) {
            var num = m[1];
            var bodyStart = re.lastIndex;
            var end = latin.indexOf('endobj', bodyStart);
            if (end < 0) end = latin.length;
            var body = latin.slice(bodyStart, end);
            var sm = /\bstream\r?\n?/.exec(body);
            var dict = sm ? body.slice(0, sm.index) : body;
            var stream = null;
            if (sm) {
                var sStart = sm.index + sm[0].length;
                var sEnd = body.lastIndexOf('endstream');
                if (sEnd < 0) sEnd = body.length;
                stream = body.slice(sStart, sEnd);
                // 去掉结尾换行
                stream = stream.replace(/\r?\n$/, '');
            }
            objs[num] = { dict: dict, stream: stream };
            re.lastIndex = end;
        }
        return objs;
    }

    function contentStreams(objs, latin) {
        // 页面顺序：/Type/Pages 里的 /Kids
        var pagesObjNum = null;
        for (var k in objs) {
            if (/\/Type\s*\/Pages/.test(objs[k].dict)) { pagesObjNum = k; break; }
        }
        var order = [];
        if (pagesObjNum) {
            var kids = /\/Kids\s*\[([^\]]*)\]/.exec(objs[pagesObjNum].dict);
            if (kids) {
                var refs = kids[1].match(/(\d+)\s+\d+\s+R/g) || [];
                for (var i = 0; i < refs.length; i++) {
                    var r = /(\d+)/.exec(refs[i])[1];
                    if (objs[r]) order.push(objs[r]);
                }
            }
        }
        if (!order.length) {
            for (var kk in objs) if (/\/Type\s*\/Page\b/.test(objs[kk].dict)) order.push(objs[kk]);
        }
        var refs2 = [], out = [];
        order.forEach(function (p) {
            var c = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(p.dict);
            if (c) refs2.push(c[1]);
        });
        return refs2;
    }

    // ---------------------------------------------------------------- 文本扫描

    function scanText(latin) {
        var items = [];
        var nums = [], strs = [];
        var x = 0, y = 0;
        var i = 0;
        while (i < latin.length) {
            var c = latin[i];
            if (c === '(') {
                var lit = readLit(latin, i);
                strs.push(lit.v);
                i = lit.next;
                continue;
            }
            if (c === '<') {
                if (latin[i + 1] === '<') { i += 2; continue; }
                var j = latin.indexOf('>', i);
                if (j < 0) break;
                strs.push(hexStr(latin.slice(i + 1, j)));
                i = j + 1;
                continue;
            }
            if (c === '[' || c === ']' || isWS(c)) { i++; continue; }
            var m = /^[^\s()<>\[\]{}\/]+/.exec(latin.slice(i));
            if (!m) { i++; continue; }
            var t = m[0];
            if (/^-?\d*\.?\d+$/.test(t)) {
                nums.push(parseFloat(t));
            } else if (t === 'Tm') {
                if (nums.length >= 6) { x = nums[nums.length - 2]; y = nums[nums.length - 1]; }
                nums.length = 0; strs.length = 0;
            } else if (t === 'Td' || t === 'TD') {
                if (nums.length >= 2) { x += nums[nums.length - 2]; y += nums[nums.length - 1]; }
                nums.length = 0; strs.length = 0;
            } else if (t === 'Tj' || t === "'" || t === '"') {
                if (strs.length) items.push({ x: x, y: y, t: utf16be(strs[strs.length - 1]) });
                nums.length = 0; strs.length = 0;
            } else if (t === 'TJ') {
                if (strs.length) items.push({ x: x, y: y, t: utf16be(strs.join('')) });
                nums.length = 0; strs.length = 0;
            } else {
                nums.length = 0; strs.length = 0;
            }
            i += t.length;
        }
        return items;
    }

    // ---------------------------------------------------------------- 业务解析

    var DAYNAMES = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];

    function parseWeeks(str) {
        var set = {};
        String(str || '').split(/[,，]/).forEach(function (seg) {
            seg = seg.trim();
            if (!seg) return;
            var odd = /单/.test(seg), even = /双/.test(seg);
            var ns = seg.match(/\d+/g);
            if (!ns) return;
            var a = parseInt(ns[0], 10);
            var b = ns.length > 1 ? parseInt(ns[1], 10) : a;
            for (var w = a; w <= b; w++) {
                if (even && w % 2 !== 0) continue;
                if (odd && w % 2 === 0) continue;
                set[w] = 1;
            }
        });
        return Object.keys(set).map(Number).sort(function (p, q) { return p - q; });
    }

    function compactWeeks(weeks) {
        var out = [], i = 0;
        weeks = weeks.slice().sort(function (a, b) { return a - b; });
        while (i < weeks.length) {
            var j = i;
            while (j + 1 < weeks.length && weeks[j + 1] === weeks[j] + 1) j++;
            out.push(i === j ? String(weeks[i]) : weeks[i] + '-' + weeks[j]);
            i = j + 1;
        }
        return out.join(',');
    }

    function pick(fields, key) {
        for (var i = 0; i < fields.length; i++) {
            if (fields[i].indexOf(key + ':') === 0) return fields[i].slice(key.length + 1).trim();
        }
        return '';
    }

    function parseBlock(text, day, meta) {
        var re = /\((\d+)-(\d+)节\)/g, m, marks = [];
        while ((m = re.exec(text))) marks.push({ i: m.index, end: re.lastIndex, s: +m[1], e: +m[2] });
        if (!marks.length) return [];
        var res = [], name = text.slice(0, marks[0].i).trim();
        for (var k = 0; k < marks.length; k++) {
            var from = marks[k].end;
            var to = (k + 1 < marks.length) ? marks[k + 1].i : text.length;
            var chunk = text.slice(from, to);
            var nextName = '';
            var cm = /学分:[\d.]+/g, mm, last = null;
            while ((mm = cm.exec(chunk))) last = mm;
            if (last) {
                nextName = chunk.slice(last.index + last[0].length).trim();
                chunk = chunk.slice(0, last.index + last[0].length);
            }
            var fields = chunk.split('/').map(function (s) { return s.trim(); });
            var weekText = (fields[0] || '').replace(/[^\d,\-周双单()（），]/g, '');
            var cls = pick(fields, '教学班');
            var codeM = /-([A-Za-z0-9]{6,})-\d+$/.exec(cls);
            res.push({
                name: name,
                code: codeM ? codeM[1] : '',
                day: day,
                s: marks[k].s,
                e: marks[k].e,
                weekText: weekText,
                weeks: parseWeeks(weekText),
                room: pick(fields, '场地'),
                campus: pick(fields, '校区'),
                teacher: pick(fields, '教师'),
                cls: cls,
                clsGroup: pick(fields, '教学班组成'),
                credits: parseFloat(pick(fields, '学分')) || 0,
                exam: pick(fields, '考核方式')
            });
            if (nextName) name = nextName;
        }
        return res;
    }

    function parseBytes(bytes) {
        var latin = toLatin1(bytes);
        var objs = parseObjects(latin);
        var refs = contentStreams(objs, latin);
        var skipRe = /打印时间|实践课程|其他课程/;
        var pages = [];
        return Promise.all(refs.map(function (num) {
            var o = objs[num];
            if (!o || !o.stream) return Promise.resolve(null);
            var raw = new Uint8Array(o.stream.length);
            for (var i = 0; i < o.stream.length; i++) raw[i] = o.stream.charCodeAt(i) & 0xff;
            var needInflate = /FlateDecode/.test(o.dict);
            return (needInflate ? zlibInflate(raw) : Promise.resolve(raw)).then(function (u8) {
                return scanText(toLatin1(u8));
            });
        })).then(function (pageItems) {
            var all = [];
            pageItems.forEach(function (it) { if (it) all = all.concat(it); });

            // 1) 先用未过滤的项定位 7 个日列（表头「星期X」只出现在首页）
            var centers = {};
            all.forEach(function (it) {
                var t = it.t.trim();
                var idx = DAYNAMES.indexOf(t);
                if (idx >= 0 && centers[idx] === undefined) centers[idx] = it.x;
            });
            var known = Object.keys(centers).map(Number).sort(function (a, b) { return a - b; });
            if (known.length < 5) throw new Error('未识别到课表表头，请确认是教务系统导出的课表 PDF');
            var colLeft = {}, colRight = {};
            for (var n = 0; n < known.length; n++) {
                var cur = known[n];
                if (n === 0) colLeft[cur] = centers[cur] - (centers[known[1]] - centers[cur]) / 2;
                else colLeft[cur] = (centers[known[n - 1]] + centers[cur]) / 2;
                if (n === known.length - 1) colRight[cur] = centers[cur] + (centers[cur] - centers[known[n - 1]]) / 2;
                else colRight[cur] = (centers[cur] + centers[known[n + 1]]) / 2;
            }
            var leftEdge = colLeft[known[0]];

            // 2) 逐页剔除表头行（含标题、学号、时间段/节次表头、星期X），
            //    注意只对有表头的那一页生效，续页的正文可能比表头还靠上。
            pageItems = pageItems.map(function (items) {
                if (!items) return items;
                var headerY = null;
                items.forEach(function (it) {
                    if (/^星期[一二三四五六日]$/.test(it.t.trim())) {
                        if (headerY === null || it.y > headerY) headerY = it.y;
                    }
                });
                if (headerY === null) return items;
                return items.filter(function (it) { return it.y < headerY - 1; });
            });

            // 3) 逐页、逐列拼接文本
            var colText = {};
            known.forEach(function (d) { colText[d] = ''; });
            pageItems.forEach(function (items) {
                if (!items) return;
                var byCol = {};
                known.forEach(function (d) { byCol[d] = []; });
                items.forEach(function (it) {
                    if (it.x < leftEdge) return;
                    if (!it.t.trim()) return;
                    if (skipRe.test(it.t)) return;
                    var best = -1, bestD = 1e9;
                    known.forEach(function (d) {
                        var cx = (colLeft[d] + colRight[d]) / 2;
                        var dist = Math.abs(it.x - cx);
                        if (dist < bestD) { bestD = dist; best = d; }
                    });
                    if (best >= 0) byCol[best].push(it);
                });
                known.forEach(function (d) {
                    byCol[d].sort(function (a, b) { return (b.y - a.y) || (a.x - b.x); });
                    colText[d] += byCol[d].map(function (o) { return o.t; }).join('');
                });
            });

            // 4) 切段解析
            var entries = [];
            known.forEach(function (d) {
                parseBlock(colText[d], d, null).forEach(function (e) { entries.push(e); });
            });

            // 5) 表头信息（学号 / 姓名 / 学年学期）
            var meta = { student: '', sid: '', term: '' };
            all.forEach(function (it) {
                var t = it.t.trim();
                var m1 = /^(\d{4}-\d{4})学年第(\d)学期$/.exec(t);
                if (m1 && !meta.term) meta.term = m1[1] + ' 第' + m1[2] + '学期';
                var m2 = /^学号[：:]\s*(\d+)$/.exec(t);
                if (m2 && !meta.sid) meta.sid = m2[1];
                var m3 = /^([\u4e00-\u9fa5]{2,5})课表$/.exec(t);
                if (m3 && !meta.student) meta.student = m3[1];
            });

            return { entries: entries, meta: meta };
        });
    }

    global.KBPdf = {
        parseBytes: parseBytes,
        parseWeeks: parseWeeks,
        compactWeeks: compactWeeks,
        inflateRaw: inflateRaw
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = global.KBPdf;
})(typeof window !== 'undefined' ? window : globalThis);
