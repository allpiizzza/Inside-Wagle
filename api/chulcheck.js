// api/chulcheck.js
// Vercel Serverless Function - 2026 출석체크 / 하반기 DB 기록
// 7~12월 각 달의 "오프라인/온라인 프로 포인트", "활동 포인트"(다중 선택)와 "총대 (1)~(3)"(체크박스)을
// 본인이 직접 켜고 끄는 용도. 다중 선택은 DB에 이미 있는 옵션 중에서만 고를 수 있음
// 면제권은 "2026 포인트 면제권"/"받았어요 면제권"에 있는 걸 사용하면 "사용했어요 면제권"으로 옮김

const NOTION_VERSION = '2022-06-28';
const ALLOWED_ORIGIN = '*';

const MONTHS = [7, 8, 9, 10, 11, 12];
const MULTI_KEYS = {
    offline: (m) => `${m}월 오프라인 프로 포인트`,
    online: (m) => `${m}월 온라인 프로 포인트`,
    activity: (m) => `${m}월 활동 포인트`,
};
const chongdaeProp = (m, i) => `${m}월 총대 (${i})`; // 괄호 앞 공백 주의

const EXEMPTION_FROM = { point: '2026 포인트 면제권', received: '받았어요 면제권' };
const EXEMPTION_USED = '사용했어요 면제권';

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function fetchSchema(headers, dbId) {
    const response = await fetch(`https://api.notion.com/v1/databases/${dbId}`, { headers });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || '출석체크 DB 조회 실패');
    return data.properties;
}

async function listNames(headers, dbId) {
    const names = [];
    let cursor = undefined;
    do {
        const response = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                sorts: [{ property: '와글러', direction: 'ascending' }],
                page_size: 100,
                start_cursor: cursor,
            }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || '출석체크 명단 조회 실패');
        data.results.forEach((page) => {
            const name = page.properties['와글러']?.title?.map((t) => t.plain_text).join('').trim();
            if (name) names.push(name);
        });
        cursor = data.has_more ? data.next_cursor : undefined;
    } while (cursor);
    return names;
}

async function findPage(headers, dbId, name) {
    const response = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            filter: { property: '와글러', title: { equals: name } },
            page_size: 2,
        }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || '출석체크 DB 조회 실패');
    return data.results[0] || null;
}

// 한 달치 선택지(스키마의 옵션) + 현재 선택값
function buildMonth(schema, props, m) {
    const month = {};
    Object.entries(MULTI_KEYS).forEach(([key, propOf]) => {
        const propName = propOf(m);
        const def = schema[propName];
        if (!def || def.type !== 'multi_select') {
            month[key] = null; // 이 달에는 해당 속성이 없음
            return;
        }
        month[key] = {
            options: def.multi_select.options.map((o) => o.name),
            selected: (props[propName]?.multi_select || []).map((o) => o.name),
        };
    });
    month.chongdae = [1, 2, 3].map((i) => {
        const propName = chongdaeProp(m, i);
        if (schema[propName]?.type !== 'checkbox') return null;
        return !!props[propName]?.checkbox;
    });
    return month;
}

const selectedNames = (prop) => (prop?.multi_select || []).map((o) => o.name);

function buildExemptions(props) {
    const owned = [];
    Object.entries(EXEMPTION_FROM).forEach(([from, propName]) => {
        selectedNames(props[propName]).forEach((name) => owned.push({ name, from }));
    });
    // 연도(YYYY)가 들어간 면제권을 연도 순으로 먼저, 나머지는 그 뒤에 이름 순
    // (이름 비교 시 앞에 붙은 이모지는 빼고 글자만으로)
    const yearOf = (name) => parseInt(name.match(/20\d{2}/)?.[0] ?? '9999', 10);
    const sortKey = (name) => name.replace(/[^\p{L}\p{N}\s]/gu, '').trim();
    owned.sort((a, b) => yearOf(a.name) - yearOf(b.name)
        || sortKey(a.name).localeCompare(sortKey(b.name), 'ko', { numeric: true }));
    return { owned, used: selectedNames(props[EXEMPTION_USED]) };
}

function formulaValue(prop) {
    if (prop?.type !== 'formula') return null;
    const f = prop.formula;
    return f[f.type] ?? null;
}

export default async function handler(req, res) {
    setCors(res);
    if (req.method === 'OPTIONS') return res.status(200).end();

    const NOTION_TOKEN = process.env.NOTION_TOKEN;
    const CHULCHECK_DB_ID = process.env.NOTION_CHULCHECK_HABANGI_DB;

    if (!NOTION_TOKEN || !CHULCHECK_DB_ID) {
        return res.status(500).json({ error: '서버에 NOTION_TOKEN / NOTION_CHULCHECK_HABANGI_DB 환경변수가 설정되지 않았어요.' });
    }

    const headers = {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
    };

    try {
        if (req.method === 'GET') {
            const name = (req.query.name || '').trim();

            // ---------- 이름 없이 호출하면 명단만 ----------
            if (!name) {
                const names = await listNames(headers, CHULCHECK_DB_ID);
                return res.status(200).json({ names });
            }

            // ---------- 한 사람의 7~12월 기록 전체 ----------
            const [schema, page] = await Promise.all([
                fetchSchema(headers, CHULCHECK_DB_ID),
                findPage(headers, CHULCHECK_DB_ID, name),
            ]);
            if (!page) return res.status(404).json({ error: '출석체크 명단에 없는 이름이에요.' });

            const months = {};
            MONTHS.forEach((m) => { months[m] = buildMonth(schema, page.properties, m); });

            return res.status(200).json({
                name,
                point: formulaValue(page.properties['2026 포인트']),
                months,
                exemptions: buildExemptions(page.properties),
            });
        }

        // ---------- 한 달치 기록 저장 (보낸 상태 그대로 덮어씀 → 끄면 삭제) ----------
        if (req.method === 'POST' && req.body?.action === 'useExemption') {
            const { name, ticket, from } = req.body;
            const srcProp = EXEMPTION_FROM[from];
            if (!name || !name.trim()) return res.status(400).json({ error: '와글러 이름을 선택해주세요.' });
            if (!ticket || !srcProp) return res.status(400).json({ error: '사용할 면제권을 선택해주세요.' });

            // 화면이 오래돼 있을 수 있으니 최신 페이지 기준으로 다시 확인
            const page = await findPage(headers, CHULCHECK_DB_ID, name.trim());
            if (!page) return res.status(404).json({ error: '출석체크 명단에 없는 이름이에요.' });

            const remaining = selectedNames(page.properties[srcProp]);
            const idx = remaining.indexOf(ticket);
            if (idx === -1) return res.status(409).json({ error: `'${ticket}'은(는) 이미 사용했거나 없는 면제권이에요. 새로고침해주세요.` });
            remaining.splice(idx, 1);
            const used = [...new Set([...selectedNames(page.properties[EXEMPTION_USED]), ticket])];

            const response = await fetch(`https://api.notion.com/v1/pages/${page.id}`, {
                method: 'PATCH',
                headers,
                body: JSON.stringify({
                    properties: {
                        [srcProp]: { multi_select: remaining.map((v) => ({ name: v })) },
                        [EXEMPTION_USED]: { multi_select: used.map((v) => ({ name: v })) },
                    },
                }),
            });
            const data = await response.json();
            if (!response.ok) {
                return res.status(response.status).json({ error: data.message || 'Notion 저장 실패' });
            }

            return res.status(200).json({
                ok: true,
                point: formulaValue(data.properties?.['2026 포인트']),
                exemptions: buildExemptions(data.properties),
            });
        }

        if (req.method === 'POST') {
            const { name, month, offline, online, activity, chongdae } = req.body || {};
            const m = parseInt(month, 10);
            if (!name || !name.trim()) return res.status(400).json({ error: '와글러 이름을 선택해주세요.' });
            if (!MONTHS.includes(m)) return res.status(400).json({ error: '7~12월 중에서 선택해주세요.' });

            const [schema, page] = await Promise.all([
                fetchSchema(headers, CHULCHECK_DB_ID),
                findPage(headers, CHULCHECK_DB_ID, name.trim()),
            ]);
            if (!page) return res.status(404).json({ error: '출석체크 명단에 없는 이름이에요.' });

            const properties = {};
            const values = { offline, online, activity };
            for (const [key, propOf] of Object.entries(MULTI_KEYS)) {
                const propName = propOf(m);
                const def = schema[propName];
                if (!def || def.type !== 'multi_select' || !Array.isArray(values[key])) continue;

                // 없는 옵션을 보내면 Notion이 새 옵션을 만들어버리므로 여기서 막음
                const allowed = new Set(def.multi_select.options.map((o) => o.name));
                const unknown = values[key].filter((v) => !allowed.has(v));
                if (unknown.length) {
                    return res.status(400).json({ error: `'${propName}'에 없는 항목이에요: ${unknown.join(', ')}` });
                }
                properties[propName] = { multi_select: [...new Set(values[key])].map((v) => ({ name: v })) };
            }
            if (Array.isArray(chongdae)) {
                [1, 2, 3].forEach((i) => {
                    const propName = chongdaeProp(m, i);
                    if (schema[propName]?.type === 'checkbox' && typeof chongdae[i - 1] === 'boolean') {
                        properties[propName] = { checkbox: chongdae[i - 1] };
                    }
                });
            }

            const response = await fetch(`https://api.notion.com/v1/pages/${page.id}`, {
                method: 'PATCH',
                headers,
                body: JSON.stringify({ properties }),
            });
            const data = await response.json();
            if (!response.ok) {
                return res.status(response.status).json({ error: data.message || 'Notion 저장 실패' });
            }

            return res.status(200).json({
                ok: true,
                month: m,
                point: formulaValue(data.properties?.['2026 포인트']),
                record: buildMonth(schema, data.properties, m),
            });
        }

        res.setHeader('Allow', ['GET', 'POST', 'OPTIONS']);
        return res.status(405).json({ error: `허용되지 않는 메서드: ${req.method}` });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}
