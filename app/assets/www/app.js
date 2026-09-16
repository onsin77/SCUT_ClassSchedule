/* =========================================================================
 * 华工课程表 —— 应用逻辑
 * 数据全部保存在本机 localStorage；通知由原生 AlarmManager 负责触发。
 * ========================================================================= */
(function () {
    'use strict';

    var A = window.Android || null;   // 原生桥，浏览器里打开时为 null
    var LS_KEY = 'scut_kcb_db_v1';

    var DAY_FULL = ['', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];
    var DAY_SHORT = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    var DAY_SINGLE = ['', '一', '二', '三', '四', '五', '六', '日'];

    // 每节固定 54px（和 CSS 的 --row-h 对齐）；分段处再多让这么多，把分割线放进空隙里
    var SEC_GAP = 20;

    // 12 色。自动分配时按 5 递增（5 与 12 互质），前 12 门课的颜色互不重复
    var PALETTE = [
        '#CFE0FA', '#D8EFDC', '#FCE6C6', '#F7D8E3',
        '#E0DAF6', '#D2ECF4', '#F0E4CB', '#DCE3EA',
        '#FAD9D2', '#DFF0C8', '#F6E7C1', '#E8DCF0'
    ];
    var COLOR_STRIDE = 5;

    // 作息时间（华工公开作息表）
    var TIMETABLES = {
        dxc: {
            name: '大学城 / 国际校区',
            times: ['08:50', '09:40', '10:40', '11:30', '14:00', '14:50', '15:45', '16:35', '19:00', '19:55', '20:50', '21:45'],
            ends: ['09:35', '10:25', '11:25', '12:15', '14:45', '15:35', '16:30', '17:20', '19:45', '20:40', '21:35', '22:30']
        },
        ws: {
            name: '五山校区',
            times: ['08:00', '08:55', '10:00', '10:55', '14:30', '15:25', '16:20', '17:15', '19:00', '19:55', '20:50', '21:45'],
            ends: ['08:45', '09:40', '10:45', '11:40', '15:15', '16:10', '17:05', '18:00', '19:45', '20:40', '21:35', '22:30']
        }
    };

    /* ------------------------------------------------------------------ 状态 */

    function defaults() {
        return {
            v: 1,
            meta: { student: '', sid: '', term: '', firstWeekMonday: '2026-08-31' },
            entries: [],
            marks: {},
            colors: {},
            days: {},
            msgs: {},
            settings: {
                dailyOn: true,
                dailyTimes: ['08:00', '13:00', '18:00'],
                dailyWhenEmpty: false,
                preOn: true,
                preMin: 10,
                notifyNormal: true,
                notifyEasy: false,
                signOn: false,
                periods: 11,
                totalWeeks: 20,
                timetable: 'dxc',
                weekend: 'auto'
            }
        };
    }

    var DB = defaults();
    var currentWeek = 1;

    function load() {
        try {
            var raw = localStorage.getItem(LS_KEY);
            if (raw) {
                var o = JSON.parse(raw);
                DB = mergeDeep(defaults(), o);
            }
        } catch (e) { }
        // 每日提醒从两条（早/中）扩成三条（早上/下午/晚上），老数据补上
        if (!Array.isArray(DB.settings.dailyTimes) || DB.settings.dailyTimes.length !== 3) {
            DB.settings.dailyTimes = ['08:00', '13:00', '18:00'];
        }
    }

    function save() {
        try { localStorage.setItem(LS_KEY, JSON.stringify(DB)); } catch (e) { }
    }

    function mergeDeep(base, over) {
        if (!over || typeof over !== 'object') return base;
        Object.keys(over).forEach(function (k) {
            var v = over[k];
            if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
                mergeDeep(base[k], v);
            } else if (v !== undefined && v !== null) {
                base[k] = v;
            }
        });
        return base;
    }

    function uid() {
        return 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    }

    /** 给一串内容算个短 id（用来给一样的图片去重） */
    function hashOf(s) {
        var h = 0;
        for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
        return h.toString(36);
    }

    /* ------------------------------------------------------------------ 日期 */

    function pad(n) { return (n < 10 ? '0' : '') + n; }
    function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
    function parseYmd(s) { var p = String(s).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
    function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
    function addDays(d, n) { var x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
    function hm(str) { var p = String(str).split(':'); return { h: +p[0], m: +p[1] }; }
    function atTime(day, str) {
        var t = hm(str);
        return new Date(day.getFullYear(), day.getMonth(), day.getDate(), t.h, t.m, 0, 0).getTime();
    }
    function dowOf(d) { var w = d.getDay(); return w === 0 ? 7 : w; }

    function firstMonday() {
        var s = DB.meta.firstWeekMonday || '2026-08-31';
        var d = parseYmd(s);
        var w = dowOf(d);
        if (w !== 1) d = addDays(d, 1 - w);
        return startOfDay(d);
    }

    function weekOf(date) {
        var a = startOfDay(date).getTime();
        var b = firstMonday().getTime();
        return Math.floor((a - b) / 86400000 / 7) + 1;
    }

    function dateOf(week, dow) {
        return addDays(firstMonday(), (week - 1) * 7 + (dow - 1));
    }

    function periodTime(p, which) {
        var tt = TIMETABLES[DB.settings.timetable] || TIMETABLES.dxc;
        var arr = which === 'end' ? tt.ends : tt.times;
        return arr[Math.min(Math.max(p, 1), arr.length) - 1] || '';
    }

    /** 一节属于上午 / 下午 / 晚上 —— 按它的开始时间划（时间是零填充的，可以直接比字符串） */
    function sectionOf(p) {
        var t = periodTime(p, 'start');
        return t < '12:00' ? '上午' : (t < '18:00' ? '下午' : '晚上');
    }

    function fmtWeekRange(week) {
        var a = dateOf(week, 1), b = dateOf(week, 7);
        return (a.getMonth() + 1) + '月' + a.getDate() + '日 - ' + (b.getMonth() + 1) + '月' + b.getDate() + '日';
    }

    function totalWeeks() {
        var n = parseInt(DB.settings.totalWeeks, 10);
        if (!n || n < 1) n = 20;
        return Math.min(n, 30);
    }

    function clampWeek() {
        var max = totalWeeks();
        if (!currentWeek || currentWeek < 1) currentWeek = 1;
        if (currentWeek > max) currentWeek = max;
    }

    // 该看第几周：本周的课上完了就自动看下一周（周日晚上再打开 App 时最有用）
    function autoWeek() {
        var w = weekOf(new Date());
        if (w < 1) return 1;
        var last = 0, any = false;
        for (var d = 1; d <= 7; d++) {
            var date = dateOf(w, d);
            var dp = dayCourses(date);
            if (dp.off) continue;                    // 停课的那天不算
            dp.list.forEach(function (e) {
                any = true;
                var t = atTime(date, periodTime(e.e, 'end'));
                if (t > last) last = t;
            });
        }
        if (!any) return w;                          // 整周没课（放假）就不动，免得一路往后跳
        if (last && Date.now() > last && w < totalWeeks()) return w + 1;
        return w;
    }

    /* ------------------------------------------------------------------ 数据访问 */

    function entryOccursInWeek(e, week) {
        return (e.weeks || []).indexOf(week) >= 0;
    }

    function rawCourses(date) {
        var w = weekOf(date), dow = dowOf(date);
        return DB.entries.filter(function (e) {
            return e.day === dow && entryOccursInWeek(e, w);
        }).sort(function (a, b) { return a.s - b.s; });
    }

    /* 「禁用 / 调休」是记在具体日期上的，和课程条目分开存：
       DB.days['2026-10-01'] = { off: true }              ← 这天停课
       DB.days['2026-09-27'] = { from: '2026-10-06' }     ← 这天上周二(10-06)的课
       两种标记可以同时存在，此时 off 优先（停课就是停课）。*/

    function dayOverride(date) { return DB.days[ymd(date)] || {}; }

    /** 某一天真正要上的课：把「禁用 / 调休」都算进去 */
    function dayCourses(date) {
        var ov = dayOverride(date);
        if (ov.from && !ov.off) {
            return { list: rawCourses(parseYmd(ov.from)), off: false, moved: true };
        }
        return { list: rawCourses(date), off: !!ov.off, moved: false };
    }

    /** 这一天能不能调休：要求当天本来没课，或者已经被禁用 */
    function canSwap(date) {
        var ov = dayOverride(date);
        return !!ov.off || rawCourses(date).length === 0 || !!ov.from;
    }

    /** 把 src 那天的课挪到 dst 那天，并停掉 src（不可撤销） */
    function applySwap(srcStr, dstStr) {
        DB.days[dstStr] = DB.days[dstStr] || {};
        DB.days[dstStr].from = srcStr;
        delete DB.days[dstStr].off;
        DB.days[srcStr] = DB.days[srcStr] || {};
        DB.days[srcStr].off = true;
        save();
    }

    function markKey(e, week) { return e.id + '@' + week; }

    function getMark(e, week) {
        return DB.marks[markKey(e, week)] || {};
    }

    function setMark(e, week, patch) {
        var k = markKey(e, week);
        var m = DB.marks[k] || {};
        Object.keys(patch).forEach(function (x) { m[x] = patch[x]; });
        var empty = !m.leave && !m.sign && !(m.note && m.note.trim()) && !(m.files && m.files.length);
        if (empty) delete DB.marks[k]; else DB.marks[k] = m;
        save();
    }

    // 同一门课一个颜色：优先用用户自定义的（DB.colors），否则按课程首次出现的顺序自动分配
    function courseKey(e) { return e.code || e.name || ''; }

    /** 标记和颜色一样，作用于整门课 —— 同一门课的所有节次一起打上 */
    function setCourseTag(e, tag) {
        var k = courseKey(e);
        DB.entries.forEach(function (x) { if (courseKey(x) === k) x.tag = tag; });
        save();
    }

    function colorIndexOf(e) {
        var k = courseKey(e);
        if (DB.colors && typeof DB.colors[k] === 'number') return DB.colors[k];
        var seen = [];
        DB.entries.forEach(function (x) {
            var k2 = courseKey(x);
            if (seen.indexOf(k2) < 0) seen.push(k2);
        });
        var pos = seen.indexOf(k);
        if (pos < 0) pos = 0;
        return (pos * COLOR_STRIDE) % PALETTE.length;
    }

    function colorOf(e) { return PALETTE[colorIndexOf(e) % PALETTE.length]; }

    function maxPeriod() {
        var m = DB.settings.periods || 11;
        DB.entries.forEach(function (e) { if (e.e > m) m = e.e; });
        return m;
    }

    function visibleDays(week) {
        var mode = DB.settings.weekend;
        if (mode === 'always') return [1, 2, 3, 4, 5, 6, 7];
        var has = DB.entries.some(function (e) { return e.day >= 6; });
        // 调休可能把课挪到周末，那一周就得把周末露出来，不然课就藏起来看不见了
        if (!has && week) {
            has = [6, 7].some(function (d) {
                var ov = DB.days[ymd(dateOf(week, d))];
                return !!(ov && ov.from);
            });
        }
        if (mode === 'never') return has ? [1, 2, 3, 4, 5, 6, 7] : [1, 2, 3, 4, 5];
        return has ? [1, 2, 3, 4, 5, 6, 7] : [1, 2, 3, 4, 5];
    }

    function signState(e, week, date) {
        if (!DB.settings.signOn) return 'off';
        var m = getMark(e, week);
        if (m.leave) return 'leave';
        if (m.sign === true) return 'ok';
        var st = atTime(date || dateOf(week, e.day), periodTime(e.s, 'start'));
        return Date.now() > st ? 'miss' : 'none';
    }

    function tagLabel(t) {
        return t === 'important' ? '⭐ 重要' : (t === 'easy' ? '💧 水课' : '');
    }

    /* ------------------------------------------------------------------ 通用 UI */

    function $(id) { return document.getElementById(id); }
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    var toastTimer = null;
    function toast(msg) {
        var el = $('toast');
        el.textContent = msg;
        el.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { el.hidden = true; }, 1900);
    }

    function busy(on, text) {
        $('loadingText').textContent = text || '处理中…';
        $('loading').hidden = !on;
    }

    // 弹层和遮罩必须同时显隐：之前遮罩一直没显示，导致点空白处关不掉、也没有背景压暗
    function maskOf(el) {
        return (el && el.id === 'editSheet') ? $('editMask') : $('sheetMask');
    }
    function openSheet(el) {
        el.hidden = false;
        var m = maskOf(el);
        if (m) m.hidden = false;
    }
    function closeSheet(el) {
        el.hidden = true;
        el.style.transform = '';
        var m = maskOf(el);
        if (m) m.hidden = true;
    }

    /* ------------------------------------------------------------------ 课表渲染 */

    function renderKb() {
        var days = visibleDays(currentWeek);
        var P = maxPeriod();
        var todayW = weekOf(new Date());
        var todayDow = dowOf(new Date());
        var isThisWeek = currentWeek === todayW;

        $('wkTitle').textContent = '第 ' + currentWeek + ' 周' + (isThisWeek ? '（本周）' : '');
        $('wkRange').textContent = fmtWeekRange(currentWeek) + '　共 ' + totalWeeks() + ' 周';
        $('wkNow').hidden = isThisWeek;

        // 表头。整格就是一个隐形的按钮（点了打开当天的编辑），所以外观和以前完全一样
        var h = '<div class="kb-spacer"></div>';
        days.forEach(function (d) {
            var cls = (isThisWeek && d === todayDow) ? 'kb-daycell today' : 'kb-daycell';
            var dt = dateOf(currentWeek, d);
            h += '<div class="' + cls + '" data-date="' + ymd(dt) + '"><b>' + DAY_SINGLE[d] + '</b><span>' +
                (dt.getMonth() + 1) + '/' + dt.getDate() + '</span></div>';
        });
        $('kbDays').innerHTML = h;

        // 上午 / 下午 / 晚上 的分界：相邻两节不在同一段就在中间切一刀
        var cuts = {};
        for (var q = 1; q < P; q++) {
            if (sectionOf(q) !== sectionOf(q + 1)) cuts[q] = sectionOf(q + 1);
        }

        // 上课/下课时间：每节 54px；分段处额外让出一段行距，好把分割线放在空隙里，
        // 而不是被下一节的课块盖住。tops[p] 就是第 p 节的顶边。
        var tops = [], y = 0;
        for (var p = 1; p <= P; p++) {
            if (p > 1 && cuts[p - 1]) y += SEC_GAP;
            tops[p] = y;
            y += 54;
        }
        var totalH = y;

        // 左侧时间列：时间贴着每节的上边缘，读出来就是「这节课几点开始」
        var t = '';
        for (var p2 = 1; p2 <= P; p2++) {
            if (cuts[p2 - 1]) t += '<div class="kb-sec">' + cuts[p2 - 1] + '</div>';
            t += '<div class="kb-timecell"><b>' + p2 + '</b><span>' + periodTime(p2, 'start') + '</span></div>';
        }
        $('kbTimes').innerHTML = t;

        // 网格线：分段那格改成一条粗一点的深色线，落在让出来的空隙正中
        var lines = '';
        for (var q2 = 1; q2 <= P; q2++) {
            if (cuts[q2]) lines += '<i class="cut" style="top:' + (tops[q2] + 54 + (SEC_GAP - 2) / 2) + 'px"></i>';
            else lines += '<i style="top:' + (tops[q2] + 54) + 'px"></i>';
        }
        for (var c = 1; c < days.length; c++) lines += '<u style="left:' + (c * 100 / days.length) + '%"></u>';
        $('kbLines').innerHTML = lines;
        $('kbCanvas').style.height = totalH + 'px';

        // 课程块。按「列」来攒：调休会把某天的课挪到另一列上显示
        var items = [];
        days.forEach(function (d) {
            var date = dateOf(currentWeek, d);
            var dp = dayCourses(date);
            dp.list.forEach(function (e) {
                items.push({ e: e, col: d, date: date, off: dp.off });
            });
        });
        var lanes = assignLanes(items);
        var blocks = '';
        items.forEach(function (it) {
            var e = it.e;
            var lane = lanes[e.id + '@' + it.col] || { i: 0, n: 1 };
            var di = days.indexOf(it.col);
            var w = 100 / days.length;
            var left = di * w + (lane.i * w / lane.n);
            var width = w / lane.n;
            var top = tops[e.s];
            var height = tops[e.e] + 54 - tops[e.s] - 3;    // 跨过分段时把让出来的行距也算进去
            var m = getMark(e, currentWeek);
            var st = signState(e, currentWeek, it.date);
            // 整天停课的日子，课块和「请假」一个样子
            var cls = 'blk' + (height > 78 ? ' tall' : '') + ((it.off || m.leave) ? ' leave' : '');
            var glyph = '';
            if (st === 'ok') glyph = '<span class="bglyph" style="color:#12A05C">✓</span>';
            else if (st === 'miss') glyph = '<span class="bglyph" style="color:#D64545">✗</span>';
            else if (st === 'leave' || it.off) glyph = '<span class="bglyph" style="color:#8A92A0">⊘</span>';
            var marks = '';
            if (e.tag === 'important') marks += '⭐';
            else if (e.tag === 'easy') marks += '💧';
            if (m.note && m.note.trim()) marks += '📝';
            if (m.files && m.files.length) marks += '📎';
            blocks += '<div class="' + cls + '" data-id="' + e.id + '" data-week="' + currentWeek +
                '" data-dow="' + it.col + '" ' +
                'style="left:calc(' + left + '% + 1px);width:calc(' + width + '% - 2px);top:' + top + 'px;height:' + height + 'px;background:' + colorOf(e) + '">' +
                '<div class="bn">' + esc(e.name) + '</div>' +
                (height > 44 ? '<div class="br">' + esc(e.room || '') + '</div>' : '') +
                (marks ? '<div class="bmark">' + marks + '</div>' : '') + glyph + '</div>';
        });
        $('kbBlocks').innerHTML = blocks;

        $('kbEmpty').hidden = items.length > 0;
    }

    function assignLanes(list) {
        var out = {};
        var byCol = {};
        list.forEach(function (it) {
            (byCol[it.col] = byCol[it.col] || []).push(it.e);
        });
        Object.keys(byCol).forEach(function (c) {
            var arr = byCol[c].slice().sort(function (a, b) { return (a.s - b.s) || (a.e - b.e); });
            var groups = [], cur = [], curEnd = -1;
            arr.forEach(function (e) {
                if (cur.length && e.s > curEnd) { groups.push(cur); cur = []; curEnd = -1; }
                cur.push(e);
                curEnd = Math.max(curEnd, e.e);
            });
            if (cur.length) groups.push(cur);
            groups.forEach(function (g) {
                g.forEach(function (e, i) { out[e.id + '@' + c] = { i: i, n: g.length }; });
            });
        });
        return out;
    }

    /* ------------------------------------------------------------------ 消息中心 */

    // 消息就是"已经或即将发出的提醒"。key 与提醒计划一致，因此重复生成既不会产生重复消息，
    // 也不会把用户已经读过的内容重新标成未读。
    function syncMsgs(plan) {
        var changed = false;
        Object.keys(plan).forEach(function (k) {
            var p = plan[k];
            var cur = DB.msgs[k];
            if (cur) {
                if (cur.at !== p.at || cur.title !== p.title || cur.body !== p.body) {
                    cur.at = p.at;
                    cur.title = p.title;
                    cur.body = p.body;
                    cur.kind = p.channel;
                    changed = true;
                }
            } else {
                DB.msgs[k] = { at: p.at, title: p.title, body: p.body, kind: p.channel, read: false };
                changed = true;
            }
        });
        // 每天早上清掉昨天的：消息中心只留今天的，不然越攒越多
        var dayStart = startOfDay(new Date()).getTime();
        Object.keys(DB.msgs).forEach(function (k) {
            if (!DB.msgs[k] || DB.msgs[k].at < dayStart) { delete DB.msgs[k]; changed = true; }
        });
        // 同一时刻、同样内容只留一条。老版本的 key 里带课程序号，
        // 课表顺序一变就会攒出若干看不出区别的"重复"消息，在这里合并掉。
        var seen = {};
        Object.keys(DB.msgs).sort().forEach(function (k) {
            var m = DB.msgs[k];
            if (!m) { delete DB.msgs[k]; changed = true; return; }
            var sig = m.at + '|' + m.title + '|' + m.body;
            if (seen[sig]) {
                if (!m.read) seen[sig].read = false;   // 有一条没读过，合并后仍算未读
                delete DB.msgs[k];
                changed = true;
            } else seen[sig] = m;
        });
        if (changed) save();
    }

    function pastMsgs() {
        var now = Date.now();
        return Object.keys(DB.msgs).map(function (k) {
            var m = DB.msgs[k];
            // 带上 key（点开详情要按它查），用浅拷贝，别把 key 写回存储
            return m ? { key: k, at: m.at, title: m.title, body: m.body, kind: m.kind, read: m.read } : null;
        }).filter(function (m) { return m && m.at <= now; })
            .sort(function (a, b) { return b.at - a.at; });
    }

    /** 某条消息对应的那节课，这次带了哪些附件 */
    function msgFiles(key) {
        var g = /^p(\d{4}-\d{2}-\d{2})_(.+)$/.exec(key);
        if (!g) return [];
        var e = DB.entries.filter(function (x) { return x.id === g[2]; })[0];
        if (!e) return [];
        return getMark(e, weekOf(parseYmd(g[1]))).files || [];
    }

    function openMsgDetail(key) {
        var m = DB.msgs[key];
        if (!m) return;
        var d = new Date(m.at);
        var files = msgFiles(key);
        m.read = true;
        save();
        $('sheetBody').innerHTML =
            '<div class="sheet-head"><span class="t">' + (m.kind === 'daily' ? '📅 ' : '⏰ ') + esc(m.title) + '</span></div>' +
            '<div class="msg-detail-time">' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + DAY_FULL[dowOf(d)] +
            ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + '　·　' +
            (m.kind === 'daily' ? '每日课表' : '课前提醒') + '</div>' +
            '<div class="msg-detail-body">' + esc(m.body) + '</div>' +
            attHtml(files, false);
        $('sheetBody').dataset.id = '';
        $('sheetBody').onclick = function (ev) {
            var it = ev.target.closest('.att-item');
            if (it) openAtt(files[+it.dataset.att]);
        };
        openSheet($('sheet'));
        renderMsg();
        updateDot();
    }

    function unreadCount() {
        return pastMsgs().filter(function (m) { return !m.read; }).length;
    }

    function updateDot() {
        var d = $('msgDot');
        if (!d) return;
        d.hidden = unreadCount() <= 0;
    }

    function markAllRead() {
        var now = Date.now(), changed = false;
        Object.keys(DB.msgs).forEach(function (k) {
            var m = DB.msgs[k];
            if (m && m.at <= now && !m.read) { m.read = true; changed = true; }
        });
        if (changed) save();
        updateDot();
    }

    function renderMsg() {
        var list = pastMsgs();
        $('msgEmpty').hidden = list.length > 0;
        var unread = list.filter(function (m) { return !m.read; }).length;
        $('msgSub').textContent = list.length
            ? ('共 ' + list.length + ' 条' + (unread ? ' · ' + unread + ' 条未读' : ''))
            : '暂无消息';

        var html = '', lastDay = '';
        list.forEach(function (m) {
            var d = new Date(m.at);
            var day = ymd(d);
            if (day !== lastDay) {
                lastDay = day;
                html += '<div class="msg-day">' + (d.getMonth() + 1) + '月' + d.getDate() + '日 · ' +
                    DAY_SHORT[dowOf(d)] + '</div>';
            }
            html += '<div class="msg-item' + (m.read ? '' : ' unread') + '" data-msg="' + esc(m.key) + '">' +
                '<div class="mi">' + (m.kind === 'daily' ? '📅' : '⏰') + '</div>' +
                '<div class="mb"><div class="mt">' + esc(m.title) + '</div>' +
                '<div class="mc">' + esc(m.body) + '</div>' +
                '<div class="mtime">' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + '　点开看全文</div></div>' +
                (m.read ? '' : '<i class="mdot"></i>') +
                '</div>';
        });
        $('msgList').innerHTML = html;
    }

    /* ------------------------------------------------------------------ 原始表 */

    function renderRaw() {
        var days = [1, 2, 3, 4, 5, 6, 7];
        var list = DB.entries.slice().sort(function (a, b) { return (a.day - b.day) || (a.s - b.s); });
        $('rawEmpty').hidden = list.length > 0;

        var cred = list.reduce(function (s, e) {
            return s + (e.credits || 0);
        }, 0);
        $('rawMeta').innerHTML =
            '姓名：<b>' + esc(DB.meta.student || '未设置') + '</b>　学号：<b>' + esc(DB.meta.sid || '未设置') + '</b><br>' +
            '学期：<b>' + esc(DB.meta.term || '未设置') + '</b><br>' +
            '课程条目：<b>' + list.length + '</b> 条　学分合计：<b>' + cred.toFixed(1) + '</b>';

        var html = '';
        days.forEach(function (d) {
            var arr = list.filter(function (e) { return e.day === d; });
            if (!arr.length) return;
            html += '<div class="day-group-title">' + DAY_FULL[d] + '（' + arr.length + '）</div>';
            arr.forEach(function (e) {
                html += '<div class="course-card" data-raw="' + e.id + '">' +
                    '<div class="bar" style="background:' + colorOf(e) + '"></div>' +
                    '<div class="cbody">' +
                    '<div class="cname">' + esc(e.name) + (e.code ? ' <span class="dim">' + esc(e.code) + '</span>' : '') + '</div>' +
                    '<div class="ctime">第' + e.s + '-' + e.e + '节　' + periodTime(e.s, 'start') + ' - ' + periodTime(e.e, 'end') + '</div>' +
                    '<div class="cinfo">' + esc([e.room, e.teacher].filter(Boolean).join(' · ') || '—') + '</div>' +
                    '<div class="cinfo">周次：' + esc(e.weekText || '—') + '　' + (e.credits || 0) + ' 学分</div>' +
                    (e.cls ? '<div class="cinfo dim">' + esc(e.cls) + '</div>' : '') +
                    '</div></div>';
            });
        });
        $('rawList').innerHTML = html;
    }

    /* ------------------------------------------------------------------ 设置 */

    function renderSet() {
        var s = DB.settings;
        $('setFirstWeek').value = DB.meta.firstWeekMonday;
        $('setTotalWeeks').value = totalWeeks();
        $('setPeriods').value = String(s.periods);
        $('setTimetable').value = s.timetable;
        $('setWeekend').value = s.weekend;
        $('setDailyOn').toggleAttribute('on', !!s.dailyOn);
        $('setDaily1').value = s.dailyTimes[0] || '08:00';
        $('setDaily2').value = s.dailyTimes[1] || '13:00';
        $('setDaily3').value = s.dailyTimes[2] || '18:00';
        $('setDailyEmpty').toggleAttribute('on', !!s.dailyWhenEmpty);
        $('setPreOn').toggleAttribute('on', !!s.preOn);
        $('setPreMin').value = String(s.preMin);
        $('setNotifyNormal').toggleAttribute('on', !!s.notifyNormal);
        $('setNotifyEasy').toggleAttribute('on', !!s.notifyEasy);
        $('setSignOn').toggleAttribute('on', !!s.signOn);
    }

    /* ------------------------------------------------------------------ 详情弹层 */

    function openDetail(id, week, dow) {
        var e = DB.entries.filter(function (x) { return x.id === id; })[0];
        if (!e) return;
        // dow 是「这一节显示在第几列」——调休会把课挪到别的列上，签到时间要按那一列算
        var date = dateOf(week, dow || e.day);
        $('sheetBody').onclick = null;
        var m = getMark(e, week);
        var st = signState(e, week, date);
        var ov = dayOverride(date);

        var h = '<div class="sheet-head"><span class="dot" style="background:' + colorOf(e) + '"></span>' +
            '<span class="t">' + esc(e.name) + '</span></div>' +
            '<div class="sheet-sub">' + DAY_FULL[e.day] + ' · 第 ' + e.s + '-' + e.e + ' 节 · 第 ' + week + ' 周' +
            (ov.off ? '　·　当天停课' : ov.from ? '　·　调休到此日' : '') + '</div>';

        h += kv('时间', periodTime(e.s, 'start') + ' - ' + periodTime(e.e, 'end'));
        h += kv('地点', e.room || '—');
        h += kv('教师', e.teacher || '—');
        if (e.campus) h += kv('校区', e.campus);
        h += kv('周次', e.weekText || '—');
        if (e.cls) h += kv('教学班', e.cls);
        h += kv('学分', (e.credits || 0) + '');
        h += kv('状态', st === 'ok' ? '<span style="color:#12A05C">已签到 ✓</span>'
            : st === 'miss' ? '<span style="color:#D64545">未签到 ✗</span>'
                : st === 'leave' ? '<span style="color:#8A92A0">已请假</span>' : '—');
        h += kv('标记', tagLabel(e.tag) || '未标记');
        h += kv('备注', m.note ? esc(m.note) : '—');
        h += attHtml(m.files, false);

        h += '<div class="act-grid">' +
            act('leave', m.leave ? '取消请假' : '请假', '🙋', m.leave, false) +
            act('note', '备注', '📝', !!(m.note && m.note.trim()) || !!(m.files && m.files.length), false) +
            (DB.settings.signOn ? act('sign', m.sign === true ? '取消签到' : '签到', '✅', m.sign === true, false) : '') +
            act('tag', '标记', '🏷️', e.tag && e.tag !== 'none', false) +
            act('edit', '编辑', '✏️', false, false) +
            act('del', '删除', '🗑️', false, true) +
            '</div>';

        $('sheetBody').innerHTML = h;
        $('sheetBody').dataset.id = id;
        $('sheetBody').dataset.week = week;
        // 详情里点附件：图片全屏看，其它文件系统打开
        $('sheetBody').onclick = function (ev) {
            var it = ev.target.closest('.att-item');
            if (it) openAtt((m.files || [])[+it.dataset.att]);
        };
        openSheet($('sheet'));
    }

    function kv(k, v) {
        return '<div class="kv"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>';
    }

    function act(name, label, icon, on, danger, off) {
        return '<button class="act' + (on ? ' on' : '') + (danger ? ' danger' : '') + (off ? ' off' : '') +
            '" data-act="' + name + '">' +
            '<span class="ai">' + icon + '</span><span>' + label + '</span></button>';
    }

    /* ---------- 备注附件 ---------- */

    function attHtml(files, del) {
        if (!files || !files.length) return del ? '<div class="att-empty">还没有附件</div>' : '';
        return '<div class="att-list">' + files.map(function (f, i) {
            var img = f.d && f.d.indexOf('data:image/') === 0;
            return '<div class="att-item" data-att="' + i + '">' +
                (img ? '<img class="att-thumb" alt="" src="' + f.d + '">' : '<div class="att-thumb file">📄</div>') +
                '<div class="att-name">' + esc(f.n) + '</div>' +
                (del ? '<button class="att-del" data-del="' + i + '">✕</button>' : '') +
                '</div>';
        }).join('') + '</div>';
    }

    /** 图片直接在 App 内全屏看；其它文件交给系统里已安装的应用打开。 */
    function openAtt(f) {
        if (!f) return;
        if (f.d && f.d.indexOf('data:image/') === 0) {
            $('viewerImg').src = f.d;
            $('viewer').hidden = false;
            return;
        }
        if (!A || !A.openFile) { toast('请在 App 内使用该功能'); return; }
        A.openFile(f.n, f.t || 'application/octet-stream', f.d.slice(f.d.indexOf(',') + 1));
    }

    /* ------------------------------------------------------------------ 编辑表单 */

    var editWeeks = [];

    function openEdit(entry) {
        var e = entry || {
            id: '', name: '', code: '', teacher: '', room: '', campus: '大学城校区',
            day: 1, s: 1, e: 2, weeks: [], weekText: '', cls: '', credits: 0, tag: 'none'
        };
        editWeeks = (e.weeks || []).slice();
        $('editTitle').textContent = entry ? '编辑课程' : '添加课程';

        var h = '';
        h += frow('课程名称 *', '<input type="text" id="fName" value="' + esc(e.name) + '" placeholder="如：线性代数与解析几何">');
        h += '<div class="frow"><div class="f2">' +
            '<div><div class="flabel">星期</div><select id="fDay">' +
            [1, 2, 3, 4, 5, 6, 7].map(function (d) {
                return '<option value="' + d + '"' + (e.day === d ? ' selected' : '') + '>' + DAY_FULL[d] + '</option>';
            }).join('') + '</select></div>' +
            '<div><div class="flabel">学分</div><input type="number" step="0.5" id="fCredits" value="' + (e.credits || 0) + '"></div>' +
            '</div></div>';
        h += '<div class="frow"><div class="f2">' +
            '<div><div class="flabel">开始节次</div><select id="fStart">' + opts(1, 12, e.s) + '</select></div>' +
            '<div><div class="flabel">结束节次</div><select id="fEnd">' + opts(1, 12, e.e) + '</select></div>' +
            '</div></div>';
        h += '<div class="frow"><div class="flabel">上课周次（已选 <b id="fWeekCount">' + editWeeks.length + '</b> 周）</div>' +
            '<div class="weeks-grid" id="fWeeks"></div>' +
            '<div class="quick-row">' +
            '<button class="quick" data-wq="all">全选</button>' +
            '<button class="quick" data-wq="odd">单周</button>' +
            '<button class="quick" data-wq="even">双周</button>' +
            '<button class="quick" data-wq="clear">清空</button>' +
            '</div></div>';
        h += '<div class="frow"><div class="f2">' +
            '<div><div class="flabel">教师</div><input type="text" id="fTeacher" value="' + esc(e.teacher) + '"></div>' +
            '<div><div class="flabel">地点</div><input type="text" id="fRoom" value="' + esc(e.room) + '"></div>' +
            '</div></div>';
        h += '<div class="frow"><div class="f2">' +
            '<div><div class="flabel">校区</div><input type="text" id="fCampus" value="' + esc(e.campus) + '"></div>' +
            '<div><div class="flabel">课程代码</div><input type="text" id="fCode" value="' + esc(e.code) + '"></div>' +
            '</div></div>';
        h += frow('教学班', '<input type="text" id="fCls" value="' + esc(e.cls) + '">');
        h += '<div class="frow"><div class="flabel">标记</div><select id="fTag">' +
            '<option value="none"' + (e.tag === 'none' ? ' selected' : '') + '>不标记</option>' +
            '<option value="important"' + (e.tag === 'important' ? ' selected' : '') + '>⭐ 重要</option>' +
            '<option value="easy"' + (e.tag === 'easy' ? ' selected' : '') + '>💧 水课</option>' +
            '</select></div>';
        h += '<div class="frow"><div class="flabel">颜色（同一门课统一用这个色）</div><div class="color-grid" id="fColors"></div></div>';
        h += '<div class="form-actions">' +
            '<button class="cancel" id="fCancel">取消</button>' +
            '<button class="save" id="fSave">保存</button></div>';

        $('editBody').innerHTML = h;
        $('editBody').dataset.id = e.id || '';
        drawWeeks();
        drawColors(colorIndexOf(e));
        openSheet($('editSheet'));
    }

    function frow(label, inner) {
        return '<div class="frow"><div class="flabel">' + label + '</div>' + inner + '</div>';
    }

    function opts(a, b, sel) {
        var o = '';
        for (var i = a; i <= b; i++) o += '<option value="' + i + '"' + (i === sel ? ' selected' : '') + '>' + i + '</option>';
        return o;
    }

    function drawWeeks() {
        var g = $('fWeeks');
        if (!g) return;
        var h = '';
        var maxW = totalWeeks();
        for (var w = 1; w <= maxW; w++) {
            h += '<div class="wchip"' + (editWeeks.indexOf(w) >= 0 ? ' on' : '') + ' data-w="' + w + '">' + w + '</div>';
        }
        g.innerHTML = h;
        var c = $('fWeekCount');
        if (c) c.textContent = editWeeks.length;
    }

    var pickedColor = 0;
    function drawColors(sel) {
        pickedColor = sel;
        var g = $('fColors');
        if (!g) return;
        g.innerHTML = PALETTE.map(function (c, i) {
            return '<div class="wchip" data-c="' + i + '" style="background:' + c + ';' +
                (i === sel ? 'box-shadow:0 0 0 2px #1F5FD0' : '') + '"></div>';
        }).join('');
    }

    function saveEdit() {
        var name = $('fName').value.trim();
        if (!name) { toast('请填写课程名称'); return; }
        var id = $('editBody').dataset.id;
        var s = +$('fStart').value, eN = +$('fEnd').value;
        if (eN < s) { toast('结束节次不能早于开始节次'); return; }
        if (!editWeeks.length) { toast('请至少选择一个周次'); return; }
        var weeks = editWeeks.slice().sort(function (a, b) { return a - b; });

        var obj = {
            id: id || uid(),
            name: name,
            code: $('fCode').value.trim(),
            teacher: $('fTeacher').value.trim(),
            room: $('fRoom').value.trim(),
            campus: $('fCampus').value.trim(),
            day: +$('fDay').value,
            s: s, e: eN,
            weeks: weeks,
            weekText: compact(weeks) + '周',
            cls: $('fCls').value.trim(),
            credits: parseFloat($('fCredits').value) || 0,
            tag: $('fTag').value
        };

        if (id) {
            DB.entries = DB.entries.map(function (x) { return x.id === id ? obj : x; });
        } else {
            DB.entries.push(obj);
        }
        DB.colors[courseKey(obj)] = pickedColor;    // 颜色跟着课程走，不跟着单节课走
        // 标记同理：在这门课任意一节上改，同一门课的其它节次一起跟着变
        DB.entries.forEach(function (x) {
            if (x.id !== obj.id && courseKey(x) === courseKey(obj)) x.tag = obj.tag;
        });
        save();
        closeSheet($('editSheet'));
        closeSheet($('sheet'));
        refresh();
        scheduleAll();
        toast(id ? '已保存' : '已添加');
    }

    function compact(weeks) {
        weeks = weeks.slice().sort(function (a, b) { return a - b; });
        var out = [], i = 0;
        while (i < weeks.length) {
            var j = i;
            while (j + 1 < weeks.length && weeks[j + 1] === weeks[j] + 1) j++;
            out.push(i === j ? String(weeks[i]) : weeks[i] + '-' + weeks[j]);
            i = j + 1;
        }
        return out.join(',');
    }

    /* ------------------------------------------------------------------ 通知计划 */

    var planImgs = {};      // buildPlan 顺手填的：通知里要显示的大图

    function buildPlan() {
        var plan = {};
        planImgs = {};          // 本次计划里用到的通知大图（key -> dataURL）
        var s = DB.settings;
        var today = startOfDay(new Date());
        var now = Date.now();
        var HORIZON = 21;

        var maxW = totalWeeks();
        for (var i = 0; i < HORIZON; i++) {
            var d = addDays(today, i);
            var w = weekOf(d);
            if (w < 1 || w > maxW) continue;
            var dow = dowOf(d);
            var dp = dayCourses(d);
            if (dp.off) continue;                    // 整天停课：这天不推任何提醒
            // 同一天里，同一门课（名字+节次+地点+老师）只留一条。
            // 万一课表被导入过两遍留下重复条目，这里兜住，不会推两条一模一样的提醒。
            var seen = {};
            var occ = dp.list.filter(function (e) {
                var sig = e.name + '|' + e.s + '|' + e.e + '|' + (e.room || '') + '|' + (e.teacher || '');
                if (seen[sig]) return false;
                seen[sig] = 1;
                return true;
            });
            var dstr = ymd(d);

            // ---------- 每日课表 ----------
            // 早上那条给一整天的课表；下午、晚上各自只发本段的课，那段没课就不打扰。
            if (s.dailyOn) {
                var lineOf = function (e) {
                    var m = getMark(e, w);
                    var line = periodTime(e.s, 'start') + ' ' + e.name + (e.room ? ' · ' + e.room : '');
                    if (e.tag === 'important') line += ' ⭐';
                    if (m.leave) line += '（已请假）';
                    if (m.note) line += '\n   📝 ' + m.note;
                    return line;
                };
                [
                    { t: s.dailyTimes[0], name: '', want: '' },        // '' = 整天
                    { t: s.dailyTimes[1], name: '下午', want: '下午' },
                    { t: s.dailyTimes[2], name: '晚上', want: '晚上' }
                ].forEach(function (sg, idx) {
                    if (!sg.t) return;                                 // 时间没配就跳过
                    var at = atTime(d, sg.t);
                    if (at <= now + 20000) return;
                    var list = sg.want ? occ.filter(function (e) { return sectionOf(e.s) === sg.want; }) : occ;
                    // 下午/晚上没课就直接不提醒；早上那句"今天没课"只跟着设置走
                    if (!list.length && (idx > 0 || !s.dailyWhenEmpty)) return;
                    plan['d' + dstr + '_' + idx] = {
                        at: at,
                        title: (idx === 0 ? '今日课表' : '今日' + sg.name) + ' · ' +
                            (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + DAY_SHORT[dow],
                        body: list.length ? list.map(lineOf).join('\n') : '今天没有课，好好休息 ~',
                        channel: 'daily'
                    };
                });
            }

            // ---------- 课前提醒 ----------
            if (s.preOn) {
                occ.forEach(function (e) {
                    var m = getMark(e, w);
                    if (m.leave) return;
                    if (e.tag === 'easy' && !s.notifyEasy) return;
                    if (e.tag !== 'easy' && !s.notifyNormal) return;
                    var mins = s.preMin || 10;
                    var at = atTime(d, periodTime(e.s, 'start')) - mins * 60000;
                    if (at <= now + 20000) return;
                    var lines = [];
                    var extra = '';
                    if (e.tag === 'important') extra = '⭐ 重要课程，别迟到！\n';
                    if (e.tag === 'easy') extra = '💧 这节课是水课，可以放松一下\n';
                    lines.push('第' + e.s + '-' + e.e + '节　' + periodTime(e.s, 'start') + ' - ' + periodTime(e.e, 'end'));
                    if (e.room) lines.push('📍 ' + e.room);
                    if (e.teacher) lines.push('👤 ' + e.teacher);
                    if (m.note && m.note.trim()) lines.push('📝 ' + m.note);
                    // 备注的附件：文件名列进正文；第一张图片挂成通知大图
                    var atts = m.files || [];
                    if (atts.length) lines.push('📎 ' + atts.map(function (f) { return f.n; }).join('、'));
                    var pic = null, i;
                    for (i = 0; i < atts.length; i++) {
                        var src = atts[i].tn || atts[i].d || '';
                        if (src.indexOf('data:image/') === 0) { pic = src; break; }
                    }
                    var item = {
                        at: at,
                        title: '还有 ' + mins + ' 分钟上课 · ' + e.name,
                        body: extra + lines.join('\n'),
                        channel: 'preclass'
                    };
                    if (pic) {
                        var pk = 'i' + hashOf(pic);
                        planImgs[pk] = pic;      // 同一张图在计划里只存一份
                        item.img = pk;
                    }
                    // key 里不放序号：课程顺序一变 key 就变，消息中心会攒下一堆"重复"的旧提醒
                    plan['p' + dstr + '_' + e.id] = item;
                });
            }
        }
        return plan;
    }

    var schedTimer = null;
    function scheduleAll() {
        clearTimeout(schedTimer);
        schedTimer = setTimeout(function () {
            var plan = buildPlan();
            syncMsgs(plan);
            updateDot();
            if (currentTab === 'msg') renderMsg();
            if (!A || !A.schedule) return;
            try {
                // 计划 + 图片分开传：同一张图只传一次，重复的课不会各塞一份 base64
                A.schedule(JSON.stringify(plan), JSON.stringify(planImgs));
            } catch (err) { }
        }, 400);
    }

    /* ------------------------------------------------------------------ PDF 导出 */

    function exportRawPdf() {
        if (!A || !A.exportPdf) { toast('请在 App 内使用该功能'); return; }
        A.exportPdf('华工课程表-详细课表.pdf', wrapPrint(buildRawPrint()));
    }

    function exportWeekPdf() {
        if (!A || !A.exportPdf) { toast('请在 App 内使用该功能'); return; }
        A.exportPdf('华工课程表-第' + currentWeek + '周.pdf', wrapPrint(buildWeekPrint()));
    }

    // 生成 PDF 后直接调起系统分享面板
    function sharePdf(kind) {
        if (!A || !A.sharePdf) { toast('请在 App 内使用该功能'); return; }
        var isWeek = (kind === 'week');
        var name = isWeek ? ('华工课程表-第' + currentWeek + '周.pdf') : '华工课程表-详细课表.pdf';
        A.sharePdf(name, wrapPrint(isWeek ? buildWeekPrint() : buildRawPrint()));
    }

    // 把打印片段包成完整文档，交给原生离屏 WebView 渲染
    function wrapPrint(inner) {
        return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
            '<link rel="stylesheet" href="app.css">' +
            '<style>' +
            'html,body{background:#fff!important;margin:0;padding:8mm;color:#000;' +
            '-webkit-print-color-adjust:exact;print-color-adjust:exact;}' +
            '#print-root{display:block!important;}' +
            '</style></head><body><div id="print-root">' + inner + '</div></body></html>';
    }

    function buildRawPrint() {
        var P = maxPeriod();
        var days = [1, 2, 3, 4, 5, 6, 7];
        var cells = {};
        DB.entries.forEach(function (e) {
            var k = e.day + '_' + e.s;
            (cells[k] = cells[k] || []).push(e);
        });
        var covered = {};
        Object.keys(cells).forEach(function (k) {
            var parts = k.split('_');
            var d = +parts[0], p = +parts[1];
            var rowspan = Math.max.apply(null, cells[k].map(function (e) { return e.e - p + 1; }));
            for (var x = p + 1; x < p + rowspan; x++) covered[d + '_' + x] = 1;
        });

        var h = '<div class="p-title">' + esc((DB.meta.student || '我的') + '课表') +
            '　<span style="font-size:10pt;font-weight:400">学号：' + esc(DB.meta.sid || '—') + '</span></div>' +
            '<div class="p-sub">' + esc(DB.meta.term || '') + '　·　导出时间 ' +
            new Date().toLocaleString('zh-CN') + '　·　华工课程表 App</div>';

        h += '<table class="p-grid"><colgroup><col style="width:34px"><col style="width:30px">' +
            days.map(function () { return '<col>'; }).join('') + '</colgroup>';
        h += '<tr><th>时间段</th><th>节次</th>' + days.map(function (d) {
            return '<th>' + DAY_FULL[d] + '</th>';
        }).join('') + '</tr>';

        var seg = function (p) { return p <= 4 ? '上午' : (p <= 8 ? '下午' : '晚上'); };
        var segDone = {};
        for (var p = 1; p <= P; p++) {
            h += '<tr>';
            if (!segDone[seg(p)]) {
                var count = 0;
                for (var q = p; q <= P && seg(q) === seg(p); q++) count++;
                segDone[seg(p)] = 1;
                h += '<td class="tc" rowspan="' + count + '">' + seg(p) + '</td>';
            }
            h += '<td class="tc">' + p + '</td>';
            days.forEach(function (d) {
                var k = d + '_' + p;
                if (covered[k]) return;
                if (!cells[k]) { h += '<td></td>'; return; }
                var span = Math.max.apply(null, cells[k].map(function (e) { return e.e - p + 1; }));
                var inner = cells[k].map(function (e) {
                    return '<div class="p-cell-course">' + esc(e.name) + '</div>' +
                        '<div class="p-cell-meta">' + esc(e.weekText || '') + '</div>' +
                        '<div class="p-cell-meta">' + esc(e.campus || '') + ' ' + esc(e.room || '') + '</div>' +
                        '<div class="p-cell-meta">' + esc(e.teacher || '') +
                        (e.cls ? '　' + esc(e.cls) : '') + '</div>' +
                        '<div class="p-cell-meta">' + (e.credits || 0) + ' 学分</div>';
                }).join('<div style="height:3px"></div>');
                h += '<td rowspan="' + span + '">' + inner + '</td>';
            });
            h += '</tr>';
        }
        h += '</table>';
        h += '<div class="p-foot">共 ' + DB.entries.length + ' 条课程记录　·　学分合计 ' +
            DB.entries.reduce(function (a, b) { return a + (b.credits || 0); }, 0).toFixed(1) +
            '　·　本表按教务系统课表格式导出，仅作个人记录使用。</div>';

        return h;
    }

    function buildWeekPrint() {
        var days = visibleDays(currentWeek);
        var P = maxPeriod();
        var offDays = {};
        var byCell = {};
        days.forEach(function (d) {
            var dp = dayCourses(dateOf(currentWeek, d));
            if (dp.off) offDays[d] = 1;
            dp.list.forEach(function (e) {
                var k = d + '_' + e.s;
                (byCell[k] = byCell[k] || []).push(e);
            });
        });

        var h = '<div class="p-title">华工课程表 · 第 ' + currentWeek + ' 周</div>' +
            '<div class="p-sub">' + fmtWeekRange(currentWeek) + '　·　' +
            esc(DB.meta.student || '') + (DB.meta.sid ? '（' + esc(DB.meta.sid) + '）' : '') +
            '　·　导出时间 ' + new Date().toLocaleString('zh-CN') + '</div>';

        h += '<table class="pw-grid"><tr><th style="width:30px">节次</th>' +
            days.map(function (d) {
                var dt = dateOf(currentWeek, d);
                return '<th>' + DAY_FULL[d] + '<br>' + (dt.getMonth() + 1) + '/' + dt.getDate() + '</th>';
            }).join('') + '</tr>';

        for (var p = 1; p <= P; p++) {
            h += '<tr><td class="tc">' + p + '<br>' + periodTime(p, 'start') + '</td>';
            days.forEach(function (d) {
                var k = d + '_' + p;
                h += '<td>';
                (byCell[k] || []).forEach(function (e) {
                    var m = getMark(e, currentWeek);
                    var st = signState(e, currentWeek, dateOf(currentWeek, d));
                    var bg = colorOf(e);
                    var marks = [];
                    if (offDays[d]) marks.push('停课');
                    if (e.tag === 'important') marks.push('⭐重要');
                    if (e.tag === 'easy') marks.push('💧水课');
                    if (m.leave) marks.push('已请假');
                    if (st === 'ok') marks.push('已签到✓');
                    else if (st === 'miss') marks.push('未签到✗');
                    if (m.note) marks.push('备注：' + m.note);
                    var lines = [];
                    h += '<div class="pw-course" style="background:' + bg + '">' +
                        '<div class="pw-name">' + esc(e.name) + '</div>' +
                        '<div class="pw-mark">' + esc([e.room, e.teacher].filter(Boolean).join(' ')) + '</div>' +
                        (marks.length ? '<div class="pw-mark">' + esc(marks.join('　')) + '</div>' : '') +
                        '</div>';
                });
                h += '</td>';
            });
            h += '</tr>';
        }
        h += '</table>';

        var notes = occ.filter(function (e) {
            var m = getMark(e, currentWeek);
            return m.note || m.leave || e.tag !== 'none';
        });
        if (notes.length) {
            h += '<div class="p-foot"><b>本周备注与标记</b><br>' + notes.map(function (e) {
                var m = getMark(e, currentWeek);
                var t = DAY_FULL[e.day] + ' 第' + e.s + '-' + e.e + '节 · ' + e.name;
                var x = [];
                if (e.tag === 'important') x.push('⭐ 重要');
                if (e.tag === 'easy') x.push('💧 水课');
                if (m.leave) x.push('已请假');
                if (m.note) x.push('备注：' + m.note);
                return '· ' + t + '　' + x.join('　');
            }).join('<br>') + '</div>';
        }
        return h;
    }

    /* ------------------------------------------------------------------ 导入 */

    var importTok = null;

    function pickPdf() {
        if (!A || !A.pickFile) { toast('请在 App 内使用该功能'); return; }
        importTok = 't' + Date.now();
        A.pickFile(importTok, 'application/pdf');
    }

    /* 网页导入：交给原生打开教务系统课表页，用户自己登录、自己点「输出PDF」，
       原生把那份 PDF 截下来后回调 HG.onWebPdf()。整个过程 App 不接触账号密码。 */
    function webImport() {
        if (!A || !A.webImport) { toast('请在 App 内使用该功能'); return; }
        A.webImport();
    }

    function base64ToBytes(b64) {
        var bin = atob(b64.replace(/\s/g, ''));
        var out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    function onFileData(token, b64, name, mime) {
        if (attTok && token === attTok) { attTok = null; onAttachData(b64, name, mime); return; }
        if (!token || token !== importTok) return;
        importTok = null;
        if (!b64) { toast(name && name.length < 30 ? name : '未选择文件'); return; }

        busy(true, '正在解析课表 PDF…');
        KBPdf.parseBytes(base64ToBytes(b64)).then(function (res) {
            busy(false);
            if (!res.entries.length) {
                offerRawPdf('PDF 打开了，但没解析出课程的', b64, name);
                return;
            }
            applyImport(res);
        }).catch(function (err) {
            busy(false);
            offerRawPdf('解析失败（' + (err && err.message ? err.message : err) + '）', b64, name);
        });
    }

    /** 解析不出来时，把原始 PDF 存到「下载」目录，方便发给开发者定位格式差异。 */
    function offerRawPdf(why, b64, name) {
        if (!A || !A.saveRawPdf) { toast(why); return; }
        var msg = why + '。\n\n' +
            '点「确定」会把这份原始 PDF 存到手机的「下载/华工课程表」目录，' +
            '把它发给开发者就能定位问题。';
        if (!confirm(msg)) { toast(why); return; }
        A.saveRawPdf('课表原始-' + ymd(new Date()) + '.pdf', b64);
    }

    function applyImport(res) {
        var msg = '解析到 ' + res.entries.length + ' 条课程记录。\n\n' +
            '· 确定：替换当前全部课程\n' +
            '· 取消：追加到现有课程后面';
        var replace = confirm(msg);
        var list = res.entries.map(function (e) {
            return {
                id: uid(),
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
                tag: 'none'
            };
        }).filter(function (e) { return e.weeks.length; });

        if (replace) DB.entries = list;
        else DB.entries = DB.entries.concat(list);

        if (res.meta) {
            if (res.meta.student) DB.meta.student = res.meta.student;
            if (res.meta.sid) DB.meta.sid = res.meta.sid;
            if (res.meta.term) DB.meta.term = res.meta.term;
        }
        save(); refresh(); scheduleAll();
        toast('已导入 ' + list.length + ' 条课程');
    }

    /* ------------------------------------------------------------------ 绑定 */

    function refresh() {
        clampWeek();
        renderKb();
        renderMsg();
        renderRaw();
        renderSet();
        updateDot();
    }

    function switchTab(name) {
        ['kb', 'msg', 'raw', 'more', 'set'].forEach(function (t) {
            $('page-' + t).classList.toggle('active', t === name);
        });
        document.querySelectorAll('.tab').forEach(function (b) {
            b.classList.toggle('active', b.dataset.tab === name);
        });
        var titles = { kb: '课表', msg: '消息', raw: '详细原始课表', more: '更多', set: '设置' };
        $('tbTitle').textContent = titles[name] || '课表';
        $('tbBack').hidden = (name !== 'raw');
        currentTab = name;

        if (name === 'msg') {
            renderMsg();                       // 先按未读状态渲染一次，让用户看到哪些是新的
            setTimeout(markAllRead, 900);      // 再标记已读（只清红点，不重绘）
        }
    }

    var currentTab = 'kb';

    function bind() {
        document.querySelectorAll('.tab').forEach(function (b) {
            b.addEventListener('click', function () { switchTab(b.dataset.tab); });
        });

        $('tbBack').addEventListener('click', function () { switchTab('kb'); });
        $('btnRaw').addEventListener('click', function () { switchTab('raw'); });
        $('btnAdd').addEventListener('click', openAddMenu);
        $('btnExport').addEventListener('click', openExportMenu);

        $('wkPrev').addEventListener('click', function () { goWeek(currentWeek - 1, 'prev'); });
        $('wkNext').addEventListener('click', function () { goWeek(currentWeek + 1, 'next'); });
        $('wkNow').addEventListener('click', function () {
            var today = weekOf(new Date());
            currentWeek = autoWeek(); clampWeek(); renderKb();
            toast(currentWeek > today ? '本周已结课，已跳到第 ' + currentWeek + ' 周' : '已回到本周');
        });

        $('kbBlocks').addEventListener('click', function (ev) {
            var el = ev.target.closest('.blk');
            if (el) openDetail(el.dataset.id, +el.dataset.week, +el.dataset.dow);
        });
        // 表头每一格都是隐形按钮：点一下编辑那一天（禁用 / 调休），外观没有变化
        $('kbDays').addEventListener('click', function (ev) {
            var el = ev.target.closest('.kb-daycell');
            if (el && el.dataset.date) openDaySheet(el.dataset.date);
        });
        $('moreSwap').addEventListener('click', openSwapTool);
        $('rawList').addEventListener('click', function (ev) {
            var el = ev.target.closest('.course-card');
            if (el) openEdit(DB.entries.filter(function (x) { return x.id === el.dataset.raw; })[0]);
        });
        // 消息中心：点某一条，弹窗看全文
        $('msgList').addEventListener('click', function (ev) {
            var el = ev.target.closest('.msg-item');
            if (el && el.dataset.msg) openMsgDetail(el.dataset.msg);
        });

        $('sheetMask').addEventListener('click', function () { closeSheet($('sheet')); });
        $('editMask').addEventListener('click', function () { closeSheet($('editSheet')); });
        $('viewer').addEventListener('click', function () { $('viewer').hidden = true; });

        $('sheetBody').addEventListener('click', function (ev) {
            // 只认带 data-act 的按钮：标记选择器里的按钮用的是 data-tag，别被这条兜到
            var b = ev.target.closest('.act[data-act]');
            if (!b) return;
            handleAct(b.dataset.act, $('sheetBody').dataset.id, +$('sheetBody').dataset.week);
        });

        $('editBody').addEventListener('click', function (ev) {
            var wc = ev.target.closest('.wchip[data-w]');
            if (wc) {
                var w = +wc.dataset.w;
                var i = editWeeks.indexOf(w);
                if (i >= 0) editWeeks.splice(i, 1); else editWeeks.push(w);
                wc.toggleAttribute('on', i < 0);
                $('fWeekCount').textContent = editWeeks.length;
                return;
            }
            var cc = ev.target.closest('.wchip[data-c]');
            if (cc) { drawColors(+cc.dataset.c); return; }
            var q = ev.target.closest('.quick');
            if (q) {
                var m = q.dataset.wq;
                var maxW = totalWeeks();
                if (m === 'all') editWeeks = nums(1, maxW);
                else if (m === 'clear') editWeeks = [];
                else if (m === 'odd') editWeeks = nums(1, maxW).filter(function (x) { return x % 2; });
                else if (m === 'even') editWeeks = nums(1, maxW).filter(function (x) { return x % 2 === 0; });
                drawWeeks(); return;
            }
            if (ev.target.id === 'fCancel') closeSheet($('editSheet'));
            if (ev.target.id === 'fSave') saveEdit();
        });

        $('rawAdd').addEventListener('click', function () { openEdit(null); });
        $('rawImport').addEventListener('click', pickPdf);
        $('rawWeb').addEventListener('click', webImport);
        $('rawExport').addEventListener('click', exportRawPdf);

        // 设置项
        $('setFirstWeek').addEventListener('change', function () {
            DB.meta.firstWeekMonday = this.value; save(); refresh(); scheduleAll();
        });
        $('setTotalWeeks').addEventListener('change', function () {
            var n = parseInt(this.value, 10);
            if (!n || n < 1) n = 1;
            if (n > 30) n = 30;
            DB.settings.totalWeeks = n;
            this.value = n;
            currentWeek = Math.min(currentWeek, n);
            save(); refresh(); scheduleAll();
        });
        $('setPeriods').addEventListener('change', function () { DB.settings.periods = +this.value; save(); renderKb(); });
        $('setTimetable').addEventListener('change', function () { DB.settings.timetable = this.value; save(); refresh(); scheduleAll(); });
        $('setWeekend').addEventListener('change', function () { DB.settings.weekend = this.value; save(); renderKb(); });
        $('setDailyOn').addEventListener('click', function () { DB.settings.dailyOn = !DB.settings.dailyOn; save(); renderSet(); scheduleAll(); });
        $('setDailyEmpty').addEventListener('click', function () { DB.settings.dailyWhenEmpty = !DB.settings.dailyWhenEmpty; save(); renderSet(); scheduleAll(); });
        $('setPreOn').addEventListener('click', function () { DB.settings.preOn = !DB.settings.preOn; save(); renderSet(); scheduleAll(); });
        $('setNotifyNormal').addEventListener('click', function () { DB.settings.notifyNormal = !DB.settings.notifyNormal; save(); renderSet(); scheduleAll(); });
        $('setNotifyEasy').addEventListener('click', function () { DB.settings.notifyEasy = !DB.settings.notifyEasy; save(); renderSet(); scheduleAll(); });
        $('setSignOn').addEventListener('click', function () { DB.settings.signOn = !DB.settings.signOn; save(); renderSet(); refresh(); });
        $('setDaily1').addEventListener('change', function () { DB.settings.dailyTimes[0] = this.value; save(); scheduleAll(); });
        $('setDaily2').addEventListener('change', function () { DB.settings.dailyTimes[1] = this.value; save(); scheduleAll(); });
        $('setDaily3').addEventListener('change', function () { DB.settings.dailyTimes[2] = this.value; save(); scheduleAll(); });
        $('setPreMin').addEventListener('change', function () { DB.settings.preMin = +this.value; save(); scheduleAll(); });

        $('setNotif').addEventListener('click', function () {
            if (!A) { toast('请在 App 内使用'); return; }
            if (A.hasNotifPermission && A.hasNotifPermission()) { toast('通知权限已开启 ✓'); A.openNotificationSettings(); }
            else A.requestNotifPermission();
        });
        $('setExact').addEventListener('click', function () {
            if (!A) { toast('请在 App 内使用'); return; }
            if (A.canExactAlarm && A.canExactAlarm()) toast('精确闹钟已授权 ✓');
            else A.openExactAlarmSettings();
        });
        $('setReschedule').addEventListener('click', function () { scheduleAll(); toast('已重新排定提醒'); });
        $('setClearMsg').addEventListener('click', function () {
            if (!confirm('清空消息中心的全部记录？')) return;
            DB.msgs = {};
            save();
            renderMsg();
            updateDot();
            toast('消息中心已清空');
        });
        $('setHelp').addEventListener('click', openHelp);
        $('setClear').addEventListener('click', function () {
            if (!confirm('确定清空全部课程与设置？此操作不可恢复。')) return;
            var fw = DB.meta.firstWeekMonday;
            DB = defaults();
            DB.meta.firstWeekMonday = fw;
            save(); refresh(); scheduleAll();
            toast('已清空');
        });

        bindSwipe();
        bindSheetDrag($('sheet'), $('sheetGrab'));
        bindSheetDrag($('editSheet'), $('editGrab'));
    }

    /* ---------- 左右滑动换周 ---------- */

    function goWeek(w, dir) {
        var max = totalWeeks();
        if (w < 1) { toast('已经是第 1 周'); return; }
        if (w > max) { toast('已经是最后一周（共 ' + max + ' 周）'); return; }
        currentWeek = w;
        renderKb();
        var el = $('kbWrap');
        if (dir) {
            el.classList.remove('anim-next', 'anim-prev');
            void el.offsetWidth;                       // 强制重排，让动画能重复触发
            el.classList.add(dir === 'next' ? 'anim-next' : 'anim-prev');
        }
        $('kbBody').scrollTop = 0;
    }

    function bindSwipe() {
        var el = $('kbWrap');
        var sx = 0, sy = 0, tracking = false;
        el.addEventListener('touchstart', function (e) {
            if (e.touches.length !== 1) { tracking = false; return; }
            sx = e.touches[0].clientX;
            sy = e.touches[0].clientY;
            tracking = true;
        }, { passive: true });
        el.addEventListener('touchend', function (e) {
            if (!tracking) return;
            tracking = false;
            var t = e.changedTouches[0];
            var dx = t.clientX - sx, dy = t.clientY - sy;
            // 横向位移要够大、且明显大于纵向位移，避免和上下滚动打架
            if (Math.abs(dx) < 46 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
            goWeek(currentWeek + (dx < 0 ? 1 : -1), dx < 0 ? 'next' : 'prev');
        }, { passive: true });
        el.addEventListener('touchcancel', function () { tracking = false; }, { passive: true });
    }

    /* ---------- 弹层下拉收起 ---------- */

    function bindSheetDrag(sheet, grab) {
        var startY = 0, dy = 0, dragging = false, fromBody = false;

        function begin(y, body) {
            startY = y; dy = 0; dragging = true; fromBody = !!body;
            sheet.classList.add('dragging');
        }

        function move(y) {
            if (!dragging) return;
            dy = y - startY;
            if (fromBody && dy < 0) { dy = 0; return; }     // 从内容区只能往下拉
            if (dy < 0) dy = dy / 3;                        // 上滑给点阻尼，拉不动
            sheet.style.transform = 'translateY(' + dy + 'px)';
        }

        function end() {
            if (!dragging) return;
            dragging = false;
            sheet.classList.remove('dragging');
            sheet.style.transform = '';
            if (dy > Math.min(130, sheet.offsetHeight * 0.26)) closeSheet(sheet);
            dy = 0;
        }

        // 顶部把手：随时可拖
        grab.addEventListener('touchstart', function (e) { begin(e.touches[0].clientY, false); }, { passive: true });
        grab.addEventListener('touchmove', function (e) { move(e.touches[0].clientY); }, { passive: true });
        grab.addEventListener('touchend', end, { passive: true });
        grab.addEventListener('touchcancel', end, { passive: true });

        // 内容区：只有已经滚到顶部、且是往下拉的时候才带着整个弹层走
        var body = sheet.querySelector('.sheet-body');
        body.addEventListener('touchstart', function (e) {
            if (body.scrollTop <= 0) begin(e.touches[0].clientY, true);
            else dragging = false;
        }, { passive: true });
        body.addEventListener('touchmove', function (e) {
            if (!dragging) return;
            if (body.scrollTop > 0) { end(); return; }
            move(e.touches[0].clientY);
        }, { passive: true });
        body.addEventListener('touchend', end, { passive: true });
        body.addEventListener('touchcancel', end, { passive: true });
    }

    /* ---------- 崩溃日志 ---------- */

    function showCrashLog(text) {
        $('sheetBody').onclick = null;
        var h = '<div class="sheet-head"><span class="t">上次运行崩溃了</span></div>' +
            '<div class="sheet-sub">这是崩溃日志。存下来发给开发者，就能定位问题</div>' +
            '<textarea readonly style="width:100%;height:44vh;border:1px solid #E7EAEF;border-radius:12px;' +
            'padding:11px;font-size:11.5px;line-height:1.5;font-family:monospace;' +
            '-webkit-user-select:text;white-space:pre;background:#FBFCFD;color:#1B1F26">' +
            esc(text) + '</textarea>' +
            '<div class="form-actions">' +
            '<button class="cancel" id="crashDel">忽略</button>' +
            '<button class="save" id="crashSave">存到下载目录</button></div>';
        $('sheetBody').innerHTML = h;
        $('sheetBody').onclick = function (ev) {
            var id = ev.target.id;
            if (id !== 'crashDel' && id !== 'crashSave') return;
            $('sheetBody').onclick = null;
            if (id === 'crashSave') {
                if (A && A.saveCrashLog) A.saveCrashLog();
            } else if (A && A.clearCrashLog) {
                A.clearCrashLog();
            }
            closeSheet($('sheet'));
        };
        openSheet($('sheet'));
    }

    /* ---------- 帮助 ---------- */

    var HELP_ITEMS = [
        { i: '📅', t: '周课表', d: '主页按周显示课程，左侧时间刻度标着每节的开始时刻。上午/下午/晚上用横线隔开。左右滑动可以切上一周/下一周，也可以点上方 ‹ › 或「回到本周」；本周的课全部上完后，下次打开会自动跳到下一周。' },
        { i: '＋', t: '添加课程', d: '右上角 ＋ 有三条路：导入本地课表 PDF、网页导入（登录教务系统自动抓取）、手动添加课程。' },
        { i: '🌐', t: '网页导入', d: '会打开教务系统课表页，你自己登录后点页面上的「输出PDF」，App 会把那份 PDF 截下来自动导入。账号密码不经过本 App，也不会被保存。' },
        { i: '⤓', t: '导出与分享', d: '右上角 ⤓ 可以导出「详细课表 PDF」或「本周课表 PDF」，也可以直接分享给别人。本周课表会带上签到、请假、备注和标记。' },
        { i: '☰', t: '详细原始课表', d: '右上角 ☰ 打开完整课程列表，点任意一条即可编辑，也可以在这里增删课程。' },
        { i: '🔔', t: '每日课表提醒', d: '默认 08:00 / 13:00 / 18:00 三次。早上那条列出全天课表；下午和晚上只提醒那个时间段的课，那一段没课就不打扰。' },
        { i: '⏰', t: '课前提醒', d: '默认每节课开始前 10 分钟提醒，提前量可调。备注里加的图片会直接铺在通知上，文件会列在正文里。' },
        { i: '💬', t: '消息中心', d: '当天发过的提醒都记在这里，点任意一条能看到完整内容（含图片、文件）。到了第二天早上会自动清掉昨天的。' },
        { i: '🎨', t: '课程颜色', d: '同一门课在课表上永远同一种颜色，不同类型一眼区分。颜色不满意可以去编辑课程里改，改的是整门课。' },
        { i: '🙋', t: '请假', d: '点课块 → 请假，本周这节课会变灰划线，并且不再收到它的课前提醒。' },
        { i: '📝', t: '备注与附件', d: '点课块 → 备注，文字会跟着课前提醒一起发。还能加图片和文件（图片会先压缩，单个上限 1 MB）：图片点了全屏看，其它文件交给系统里的应用打开。' },
        { i: '✅', t: '签到', d: '需要先在设置里开启。点课块 → 签到，课块右下角打绿勾；过了上课时间还没签会自动打红叉。' },
        { i: '🏷️', t: '标记', d: '把整门课标成「⭐ 重要」或「💧 水课」，提醒文案会跟着变。标记跟着课程走——在任意一节点一次，这门课所有节次都会带上。' },
        { i: '📆', t: '单日禁课 / 调休', d: '课表最上面「周一/周二…」那一格，整格都可以点（看不出按钮，界面和以前一样）。点开能禁用当天课表——当天课块变灰、不再有任何提醒；也能调休，把别的日子的课整天地挪到这天来。' },
        { i: '🔁', t: '调休（更多页）', d: '在「更多」里：填好放假的起止日期（放假期间的课表会被禁用），需要的话点「＋」再加调休，最后点右下角「确定」一起生效。调休不可撤销，会先让你确认一次。' },
        { i: '⚙️', t: '学期设置', d: '设置里可以改：第 1 周星期一、本学期总周数、每天节数、作息时间（大学城 / 五山）、显示周末。' }
    ];

    function openHelp() {
        $('sheetBody').onclick = null;
        var h = '<div class="sheet-head"><span class="t">帮助</span></div>' +
            '<div class="sheet-sub">华工课程表 v1.0.9 · 每个功能怎么用</div>' +
            HELP_ITEMS.map(function (o) {
                return '<div class="help-item"><div class="hi">' + o.i + '</div><div style="flex:1;min-width:0">' +
                    '<div class="ht">' + o.t + '</div><div class="hd">' + o.d + '</div></div></div>';
            }).join('');
        $('sheetBody').innerHTML = h;
        openSheet($('sheet'));
    }

    function nums(a, b) { var r = []; for (var i = a; i <= b; i++) r.push(i); return r; }

    function handleAct(name, id, week) {
        var e = DB.entries.filter(function (x) { return x.id === id; })[0];
        if (!e) return;
        var m = getMark(e, week);

        if (name === 'leave') {
            setMark(e, week, { leave: !m.leave });
            toast(m.leave ? '已取消请假' : '已请假，本周不再提醒');
            closeSheet($('sheet')); refresh(); scheduleAll(); return;
        }
        if (name === 'sign') {
            setMark(e, week, { sign: m.sign === true ? null : true });
            if (m.sign !== true) { if (A && A.vibrate) A.vibrate(30); toast('已签到 ✓'); }
            closeSheet($('sheet')); refresh(); return;
        }
        if (name === 'note') { openNoteEditor(e, week); return; }
        if (name === 'tag') { openTagPicker(e, week); return; }
        if (name === 'edit') { closeSheet($('sheet')); openEdit(e); return; }
        if (name === 'del') {
            if (!confirm('删除课程「' + e.name + '」？')) return;
            DB.entries = DB.entries.filter(function (x) { return x.id !== id; });
            Object.keys(DB.marks).forEach(function (k) { if (k.indexOf(id + '@') === 0) delete DB.marks[k]; });
            save(); closeSheet($('sheet')); refresh(); scheduleAll();
            toast('已删除');
            return;
        }
    }

    var noteCtx = null;             // { e, week, text, files }
    var attTok = null;
    var MAX_ATT = 1024 * 1024;      // 单个附件上限约 1MB（localStorage 总共只有几 MB）

    function openNoteEditor(e, week) {
        var m = getMark(e, week);
        noteCtx = { e: e, week: week, text: m.note || '', files: (m.files || []).slice() };
        drawNoteEditor(true);

        $('sheetBody').onclick = function (ev) {
            var del = ev.target.closest('.att-del');
            if (del) { syncNote(); noteCtx.files.splice(+del.dataset.del, 1); drawNoteEditor(false); return; }
            var it = ev.target.closest('.att-item');
            if (it) { openAtt(noteCtx.files[+it.dataset.att]); return; }
            if (ev.target.id === 'attImg') { syncNote(); attTok = 'a' + Date.now(); A.pickFile(attTok, 'image/*'); return; }
            if (ev.target.id === 'attFile') { syncNote(); attTok = 'a' + Date.now(); A.pickFile(attTok, '*/*'); return; }
            if (ev.target.id === 'noteCancel') { $('sheetBody').onclick = null; openDetail(e.id, week); return; }
            if (ev.target.id === 'noteSave') {
                syncNote();
                var v = noteCtx.text.trim();
                setMark(e, week, { note: v, files: noteCtx.files.length ? noteCtx.files : null });
                $('sheetBody').onclick = null;
                toast(v || noteCtx.files.length ? '备注已保存' : '备注已清除');
                refresh(); scheduleAll();
                openDetail(e.id, week);
            }
        };
    }

    function drawNoteEditor(focus) {
        var e = noteCtx.e, week = noteCtx.week;
        $('sheetBody').innerHTML =
            '<div class="sheet-head"><span class="t">备注 · ' + esc(e.name) + '</span></div>' +
            '<div class="sheet-sub">' + DAY_FULL[e.day] + ' 第' + e.s + '-' + e.e + '节 · 第' + week + ' 周（仅此节）</div>' +
            '<textarea id="noteText" class="note-ta" placeholder="写点什么，会跟着课前提醒一起发">' + esc(noteCtx.text) + '</textarea>' +
            '<div class="flabel" style="margin-top:12px">附件</div>' +
            '<div id="noteAtts">' + attHtml(noteCtx.files, true) + '</div>' +
            '<div class="quick-row">' +
            '<button class="quick" id="attImg">＋ 图片</button>' +
            '<button class="quick" id="attFile">＋ 文件</button>' +
            '</div>' +
            '<div class="form-actions"><button class="cancel" id="noteCancel">取消</button>' +
            '<button class="save" id="noteSave">保存</button></div>';
        if (focus) setTimeout(function () {
            var t = $('noteText');
            if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
        }, 120);
    }

    function syncNote() {
        var t = $('noteText');
        if (t) noteCtx.text = t.value;
    }

    /** 图片先缩到 1100px 再压成 JPEG，控制住体积；其它文件只在 1MB 以内才收。 */
    function onAttachData(b64, name, mime) {
        if (!noteCtx) return;
        if (!b64) { toast(name && name.length < 30 ? name : '未选择文件'); return; }
        if (!mime) mime = /\.(jpe?g|png|gif|webp|bmp)$/i.test(name || '') ? 'image/png' : 'application/octet-stream';

        if (mime.indexOf('image/') === 0) {
            busy(true, '正在压缩图片…');
            var img = new Image();
            img.onload = function () {
                busy(false);
                var m = 1100, w = img.width, h = img.height;
                if (w > m || h > m) { var k = Math.min(m / w, m / h); w = Math.round(w * k); h = Math.round(h * k); }
                var c = document.createElement('canvas');
                c.width = w; c.height = h;
                c.getContext('2d').drawImage(img, 0, 0, w, h);
                pushAtt(name, 'image/jpeg', c.toDataURL('image/jpeg', 0.72));
            };
            img.onerror = function () { busy(false); toast('图片读不出来'); };
            img.src = 'data:' + mime + ';base64,' + b64;
            return;
        }
        var url = 'data:' + mime + ';base64,' + b64;
        if (url.length * 0.75 > MAX_ATT) { toast('文件太大了，请选 1MB 以内的'); return; }
        pushAtt(name, mime, url);
    }

    function pushAtt(name, mime, url) {
        if (url.length * 0.75 > MAX_ATT) { toast('图片压缩后还是太大，换张小点的'); return; }
        var f = { n: name || '未命名', t: mime, d: url };
        if (mime.indexOf('image/') === 0) {
            // 顺手压一张 640px 的小图给通知大图用，别把整张原图塞进提醒计划里
            var img = new Image();
            img.onload = function () {
                var m = 640, w = img.width, h = img.height;
                if (w > m || h > m) { var k = Math.min(m / w, m / h); w = Math.round(w * k); h = Math.round(h * k); }
                var c = document.createElement('canvas');
                c.width = w; c.height = h;
                c.getContext('2d').drawImage(img, 0, 0, w, h);
                f.tn = c.toDataURL('image/jpeg', 0.6);
                save();
            };
            img.src = url;
        }
        noteCtx.files.push(f);
        drawNoteEditor(false);
        toast('已添加附件');
    }

    function openTagPicker(e, week) {
        var opts = [
            { v: 'none', t: '不标记', i: '－' },
            { v: 'important', t: '重要', i: '⭐' },
            { v: 'easy', t: '水课', i: '💧' }
        ];
        $('sheetBody').innerHTML =
            '<div class="sheet-head"><span class="t">标记 · ' + esc(e.name) + '</span></div>' +
            '<div class="sheet-sub">标记作用于整门课程，会影响课前提醒内容</div>' +
            '<div class="act-grid">' + opts.map(function (o) {
                return '<button class="act' + (e.tag === o.v ? ' on' : '') + '" data-tag="' + o.v + '">' +
                    '<span class="ai">' + o.i + '</span><span>' + o.t + '</span></button>';
            }).join('') + '</div>';
        $('sheetBody').onclick = function (ev) {
            var b = ev.target.closest('.act[data-tag]');
            // 必须确认这个按钮还在弹层里 —— 打开选择器的那一下会顺带把 click 事件
            // 冒泡到 sheetBody，而那时 ev.target 已经是被换掉的旧按钮了。
            if (!b || !$('sheetBody').contains(b)) return;
            setCourseTag(e, b.dataset.tag);
            $('sheetBody').onclick = null;
            refresh(); scheduleAll();
            toast(b.dataset.tag === 'important' ? '整门课已标记为重要'
                : b.dataset.tag === 'easy' ? '整门课已标记为水课' : '已取消标记');
            openDetail(e.id, week);
        };
    }

    /* ---------- 单日编辑：禁用 / 调休 ---------- */

    function md(d) { return (d.getMonth() + 1) + '月' + d.getDate() + '日'; }

    /** 调休只能在学期范围内选日子 */
    function semRange() {
        return { min: ymd(firstMonday()), max: ymd(dateOf(totalWeeks(), 7)) };
    }

    var dayCtx = null;      // { dateStr, pick }

    function openDaySheet(dateStr) {
        dayCtx = { dateStr: dateStr, pick: '' };
        drawDaySheet();
    }

    function drawDaySheet() {
        var date = parseYmd(dayCtx.dateStr);
        var ov = dayOverride(date);
        var mine = rawCourses(date);
        var can = canSwap(date);
        var src = ov.from ? parseYmd(ov.from) : null;

        var sub = '第 ' + weekOf(date) + ' 周';
        if (src) sub += '　·　调休日：上 ' + md(src) + '（' + DAY_FULL[dowOf(src)] + '）的课';
        else if (ov.off) sub += '　·　已停课，当天没有课表和课前提醒';
        else sub += '　·　当天有 ' + mine.length + ' 节课';

        $('sheetBody').innerHTML =
            '<div class="sheet-head"><span class="t">' + DAY_FULL[dowOf(date)] + ' · ' + md(date) + '</span></div>' +
            '<div class="sheet-sub">' + sub + '</div>' +
            '<div class="act-grid">' +
            act('dayOff', ov.off ? '启用当天课表' : '禁用当天课表', ov.off ? '✅' : '🚫', ov.off, false) +
            act('daySwap', '调休', '🔁', false, false, !can) +
            '</div>' +
            (can ? '' : '<div class="hint-line">当天有课，要先「禁用当天课表」才能把别的课调过来。</div>');
        $('sheetBody').dataset.id = '';
        $('sheetBody').onclick = function (ev) {
            var b = ev.target.closest('.act[data-act]');
            if (!b || !$('sheetBody').contains(b)) return;
            if (b.dataset.act === 'dayOff') { toggleDayOff(dayCtx.dateStr); return; }
            if (b.dataset.act === 'daySwap') {
                if (!can) { toast('要先禁用当天的课程才能调休'); return; }
                drawSwapPicker();
            }
        };
        openSheet($('sheet'));
    }

    function toggleDayOff(dateStr) {
        var ov = DB.days[dateStr] || {};
        if (ov.off) delete ov.off; else ov.off = true;
        if (ov.off || ov.from) DB.days[dateStr] = ov; else delete DB.days[dateStr];
        save();
        refresh(); scheduleAll();
        toast(ov.off ? '当天已停课，不再提醒' : '当天已恢复上课');
        drawDaySheet();
    }

    function drawSwapPicker() {
        var r = semRange();
        var dst = parseYmd(dayCtx.dateStr);
        $('sheetBody').innerHTML =
            '<div class="sheet-head"><span class="t">调休 · ' + md(dst) + '</span></div>' +
            '<div class="sheet-sub">选「本来要上课的那一天」，把那天的课整天地挪到 ' + md(dst) + '</div>' +
            frow('原上课日', '<input type="date" id="swapSrc" value="' + (dayCtx.pick || r.min) +
                '" min="' + r.min + '" max="' + r.max + '">') +
            '<div class="hint-line" id="swapHint"></div>' +
            '<div class="form-actions"><button class="cancel" id="swapBack">返回</button>' +
            '<button class="save" id="swapOk">确定调休</button></div>';

        var upd = function () {
            dayCtx.pick = $('swapSrc').value;
            var src = dayCtx.pick ? parseYmd(dayCtx.pick) : null;
            if (!src) { $('swapHint').textContent = '请选择日期'; return; }
            var n = rawCourses(src).length;
            $('swapHint').textContent = n
                ? md(dst) + '（' + DAY_FULL[dowOf(dst)] + '）改上 ' + md(src) + '（' + DAY_FULL[dowOf(src)] +
                  '）的 ' + n + ' 节课；' + md(src) + ' 当天停课。此操作不可撤销。'
                : md(src) + ' 那天本来就没课，换了也没变化，请另选一天。';
        };
        $('swapSrc').addEventListener('change', upd);
        upd();

        $('sheetBody').onclick = function (ev) {
            if (ev.target.id === 'swapBack') { $('sheetBody').onclick = null; drawDaySheet(); return; }
            if (ev.target.id !== 'swapOk') return;
            var v = $('swapSrc').value;
            if (!v) { toast('请选择日期'); return; }
            if (v === dayCtx.dateStr) { toast('不能选同一天'); return; }
            if (!rawCourses(parseYmd(v)).length) { toast('那天本来就没课'); return; }
            confirmSwap(v, dayCtx.dateStr);
            $('sheetBody').onclick = null;
        };
    }

    /** 调休不可撤销，统一在这里让用户确认一次 */
    function confirmSwap(srcStr, dstStr) {
        var src = parseYmd(srcStr), dst = parseYmd(dstStr);
        var msg = md(dst) + ' 改上 ' + md(src) + ' 的课，' + md(src) + ' 当天停课。\n\n' +
            '这个操作不可撤销，确定吗？';
        if (!confirm(msg)) return false;
        applySwap(srcStr, dstStr);
        closeSheet($('sheet'));
        refresh(); scheduleAll();
        toast('已调休：' + md(dst) + ' 上 ' + md(src) + ' 的课');
        return true;
    }

    /** 把 [a, b] 之间的每一天都停掉（已经停的跳过） */
    function disableRange(aStr, bStr) {
        var a = parseYmd(aStr), b = parseYmd(bStr);
        if (b < a) { var t = a; a = b; b = t; }
        var n = 0;
        for (var d = a; d <= b; d = addDays(d, 1)) {
            var s = ymd(d);
            var ov = DB.days[s] || {};
            if (ov.off) continue;
            ov.off = true;
            DB.days[s] = ov;
            n++;
        }
        save(); refresh(); scheduleAll();
        return n;
    }

    /* ---------- 更多页：调休工具 ---------- */

    var swapDraft = [];                                       // 待提交的调休 [{src, dst}]
    var swapTool = { holA: '', holB: '', addOpen: false };    // 放假区间 + 加号是否展开

    function swapListHtml() {
        if (!swapDraft.length) return '<div class="att-empty">还没添加调休</div>';
        return '<div class="att-list">' + swapDraft.map(function (p, i) {
            return '<div class="att-item"><div class="att-thumb file">🔁</div>' +
                '<div class="att-name">' + md(parseYmd(p.src)) + ' → ' + md(parseYmd(p.dst)) + '</div>' +
                '<button class="att-del" data-sw="' + i + '">✕</button></div>';
        }).join('') + '</div>';
    }

    function openSwapTool() {
        var r = semRange();
        var today = ymd(startOfDay(new Date()));
        var a = (today >= r.min && today <= r.max) ? today : r.min;
        swapDraft = [];
        swapTool = { holA: a, holB: a, addOpen: false };
        drawSwapTool();
    }

    /** 重绘前先把用户填的日期捞回来，不然一重绘就白填了 */
    function syncSwapTool() {
        if ($('holA') && $('holA').value) swapTool.holA = $('holA').value;
        if ($('holB') && $('holB').value) swapTool.holB = $('holB').value;
    }

    function drawSwapTool() {
        var r = semRange();
        var inp = function (id, v) {
            return '<input type="date" id="' + id + '" value="' + v + '" min="' + r.min + '" max="' + r.max + '">';
        };
        $('sheetBody').innerHTML =
            '<div class="sheet-head"><span class="t">调休</span></div>' +
            '<div class="sheet-sub">选好之后，点右下角的「确定」一起生效</div>' +

            '<div class="frow"><div class="flabel">一、放假</div>' +
            '<div class="f2">' +
            '<div><div class="flabel">从</div>' + inp('holA', swapTool.holA) + '</div>' +
            '<div><div class="flabel">到</div>' + inp('holB', swapTool.holB) + '</div>' +
            '</div>' +
            '<div class="set-note" style="padding:8px 0 0">放假期间的课程表会被禁用。</div>' +
            '</div>' +

            '<div class="frow"><div class="flabel">二、调休（可选，可以加多条）</div>' +
            (swapTool.addOpen
                ? '<div class="f2">' +
                  '<div><div class="flabel">原上课日</div>' + inp('swSrc', r.min) + '</div>' +
                  '<div><div class="flabel">调到哪天</div>' + inp('swDst', r.min) + '</div>' +
                  '</div>' +
                  '<div class="quick-row"><button class="quick" id="swAdd">添加这一条</button>' +
                  '<button class="quick" id="swCancelAdd">取消</button></div>'
                : '<button class="add-row" id="swOpenAdd">＋</button>') +
            '<div id="swList">' + swapListHtml() + '</div>' +
            '</div>' +

            '<div class="form-actions right"><button class="save" id="swGo">确定</button></div>';
        $('sheetBody').dataset.id = '';

        $('sheetBody').onclick = function (ev) {
            var del = ev.target.closest('.att-del');
            if (del) {
                syncSwapTool();
                swapDraft.splice(+del.dataset.sw, 1);
                drawSwapTool();
                return;
            }
            if (ev.target.id === 'swOpenAdd') { syncSwapTool(); swapTool.addOpen = true; drawSwapTool(); return; }
            if (ev.target.id === 'swCancelAdd') { syncSwapTool(); swapTool.addOpen = false; drawSwapTool(); return; }
            if (ev.target.id === 'swAdd') {
                var src = $('swSrc').value, dst = $('swDst').value;
                if (!src || !dst) { toast('请选择两个日期'); return; }
                if (src === dst) { toast('两个日期不能一样'); return; }
                if (!rawCourses(parseYmd(src)).length) { toast('那天本来就没课，换了也没变化'); return; }
                if (swapDraft.some(function (p) { return p.dst === dst; })) { toast('那天已经安排过调休了'); return; }
                swapDraft.push({ src: src, dst: dst });
                syncSwapTool();
                swapTool.addOpen = false;        // 加完收回去，又只剩一个加号
                drawSwapTool();
                toast('已加入，点右下角确定才生效');
                return;
            }
            if (ev.target.id === 'swGo') submitSwapTool();
        };
        openSheet($('sheet'));
    }

    function submitSwapTool() {
        syncSwapTool();
        var a = swapTool.holA, b = swapTool.holB;
        var lines = [];
        if (a && b) {
            var lo = a < b ? a : b, hi = a < b ? b : a;
            lines.push('停课：' + md(parseYmd(lo)) + ' ~ ' + md(parseYmd(hi)));
        }
        swapDraft.forEach(function (p) {
            lines.push(md(parseYmd(p.dst)) + ' 上 ' + md(parseYmd(p.src)) + ' 的课，' + md(parseYmd(p.src)) + ' 停课');
        });
        if (!lines.length) { toast('没有要提交的内容'); return; }
        if (!confirm(lines.join('\n') + '\n\n确定要应用吗？调休不可撤销。')) return;

        if (a && b) disableRange(a, b);
        swapDraft.forEach(function (p) { applySwap(p.src, p.dst); });
        var n = swapDraft.length;
        swapDraft = [];
        $('sheetBody').onclick = null;
        closeSheet($('sheet'));
        refresh(); scheduleAll();
        toast('已生效' + (n ? '（含 ' + n + ' 条调休）' : ''));
    }

    /* ---------- 顶栏两个快捷菜单 ---------- */

    function sheetMenu(title, sub, items) {
        $('sheetBody').onclick = null;
        var h = '<div class="sheet-head"><span class="t">' + title + '</span></div>' +
            (sub ? '<div class="sheet-sub">' + sub + '</div>' : '') +
            '<div class="act-grid">' + items.map(function (o) {
                return '<button class="act" data-q="' + o.q + '"><span class="ai">' + o.i +
                    '</span><span>' + o.t + '</span></button>';
            }).join('') + '</div>';
        $('sheetBody').innerHTML = h;
        $('sheetBody').onclick = function (ev) {
            var b = ev.target.closest('.act');
            if (!b) return;
            var q = b.dataset.q;
            $('sheetBody').onclick = null;
            closeSheet($('sheet'));
            for (var i = 0; i < items.length; i++) {
                if (items[i].q === q && items[i].go) { items[i].go(); return; }
            }
        };
        openSheet($('sheet'));
    }

    function openAddMenu() {
        sheetMenu('添加课程', '三种方式：本地 PDF / 网页导入 / 手动录入', [
            { q: 'import', i: '📥', t: '导入课表 PDF', go: pickPdf },
            { q: 'web', i: '🌐', t: '网页导入', go: webImport },
            {
                q: 'add', i: '➕', t: '手动添加课程', go: function () {
                    switchTab('raw');
                    setTimeout(function () { openEdit(null); }, 60);
                }
            }
        ]);
    }

    function openExportMenu() {
        sheetMenu('导出', '导出为 PDF 文件，或直接分享给别人', [
            { q: 'xRaw', i: '📄', t: '导出详细课表 PDF', go: exportRawPdf },
            { q: 'xWeek', i: '🗓️', t: '导出本周课表 PDF', go: exportWeekPdf },
            { q: 'sRaw', i: '📤', t: '分享详细课表', go: function () { sharePdf('raw'); } },
            { q: 'sWeek', i: '📤', t: '分享本周课表', go: function () { sharePdf('week'); } }
        ]);
    }

    /* ------------------------------------------------------------------ 原生回调 */

    window.HG = {
        onFileData: function (token, b64, name, mime) { onFileData(token, b64, name, mime); },
        // 网页导入截获到 PDF 后由原生回调过来
        onWebPdf: function (b64, name) {
            importTok = 'web' + Date.now();
            onFileData(importTok, b64, name || '教务系统课表.pdf');
        },
        // 上次运行崩溃了：原生把栈传过来展示
        onCrashLog: function (b64) {
            var text = '';
            try { text = decodeURIComponent(escape(atob(b64))); } catch (e) { return; }
            if (!text) return;
            setTimeout(function () { showCrashLog(text); }, 400);
        },
        onSaveDone: function (ok, msg) {
            toast(msg || (ok ? '已保存' : '保存失败'));
        },
        onResume: function () {
            // 回到前台时重排提醒（时间可能跨天），顺便刷新消息红点
            scheduleAll();
            renderKb();
            updateDot();
        },
        onBack: function () {
            if (!$('viewer').hidden) { $('viewer').hidden = true; return 'handled'; }
            if (!$('editSheet').hidden) { closeSheet($('editSheet')); return 'handled'; }
            if (!$('sheet').hidden) { closeSheet($('sheet')); return 'handled'; }
            if (currentTab !== 'kb') { switchTab('kb'); return 'handled'; }
            return 'exit';
        },
        // 供调试/预览使用：拿到将要打印的 HTML
        printHtml: function (kind) {
            return wrapPrint(kind === 'week' ? buildWeekPrint() : buildRawPrint());
        },
        version: '1.0.9'
    };

    /* ------------------------------------------------------------------ 启动 */

    function init() {
        load();
        currentWeek = autoWeek();
        clampWeek();
        bind();
        refresh();
        scheduleAll();
        // 消息红点随时间推移会自动变化（到点才变成"未读"），每分钟刷新一次
        setInterval(updateDot, 60000);
        if (A && A.hasNotifPermission && !A.hasNotifPermission()) {
            setTimeout(function () {
                if (confirm('要开启通知权限吗？否则每日课表和课前提醒无法送达。')) A.requestNotifPermission();
            }, 900);
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

})();
