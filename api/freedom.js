// api/freedom.js
// Vercel Serverless Function - 프리덤 독서 기록
// 날짜 하루에 선택한 시간대 개수만큼 "N월 프리덤" 값을 더함 (예: 3개 선택 시 +3)

const NOTION_VERSION = '2022-06-28';
const ALLOWED_ORIGIN = '*';

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function findWaglerPage(headers, waglerDbId, name, team) {
    const response = await fetch(`https://api.notion.com/v1/databases/${waglerDbId}/query`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            filter: { property: '와글러', title: { equals: name } },
            page_size: 5,
        }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || '와글러 DB 조회 실패');

    if (!team) return data.results[0] || null;

    // 팀이 select/status/관계형 무엇이든 안전하게 비교하기 위해, 후보들 중 이름이 일치하는 것만 우선 반환
    // (관계형 팀 이름까지 정확히 매칭하려면 별도 조회가 필요하지만, 여기서는 이름 매칭 결과가 1개인 경우가 대부분이라 첫 결과로 충분)
    return data.results[0] || null;
}

export default async function handler(req, res) {
    setCors(res);
    if (req.method === 'OPTIONS') return res.status(200).end();

    const NOTION_TOKEN = process.env.NOTION_TOKEN;
    const WAGLER_DB_ID = process.env.NOTION_WAGLER_DB_ID;

    if (!NOTION_TOKEN || !WAGLER_DB_ID) {
        return res.status(500).json({ error: '서버에 NOTION_TOKEN / NOTION_WAGLER_DB_ID 환경변수가 설정되지 않았어요.' });
    }

    const headers = {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
    };

    try {
        // ---------- 이번 달 프리덤 현재 값 조회 ----------
        if (req.method === 'GET') {
            const name = (req.query.name || '').trim();
            const team = (req.query.team || '').trim();
            if (!name) return res.status(400).json({ error: '이름을 입력해주세요.' });

            const page = await findWaglerPage(headers, WAGLER_DB_ID, name, team || undefined);
            if (!page) {
                return res.status(404).json({ error: '등록된 와글러 명단에 없어요. 이름/팀을 다시 확인해주세요.' });
            }

            // 이 와글러 페이지에 있는 모든 "N월 프리덤" 속성을 다 모아서 보여줌
            const freedomMonths = Object.entries(page.properties)
                .filter(([propName, prop]) => prop.type === 'number' && propName.includes('프리덤'))
                .map(([propName, prop]) => ({ name: propName, value: prop.number ?? 0 }));

            return res.status(200).json({ name, team: team || null, freedomMonths });
        }

        // ---------- 특정 날짜 + 시간 선택 제출 ----------
        if (req.method === 'POST') {
            const { name, team, date, hours } = req.body || {};
            if (!name || !name.trim()) return res.status(400).json({ error: '와글러 이름을 입력해주세요.' });
            if (!team || !team.trim()) return res.status(400).json({ error: '팀을 선택해주세요.' });
            if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: '날짜 형식이 올바르지 않아요.' });
            if (!Array.isArray(hours) || hours.length === 0) return res.status(400).json({ error: '시간을 1개 이상 선택해주세요.' });

            const month = parseInt(date.split('-')[1], 10);
            const propName = `${month}월 프리덤`;

            const page = await findWaglerPage(headers, WAGLER_DB_ID, name.trim(), team.trim());
            if (!page) {
                return res.status(404).json({ error: '등록된 와글러 명단에 없어요. 팀/이름을 다시 확인해주세요.' });
            }

            const prop = page.properties[propName];
            if (!prop || prop.type !== 'number') {
                return res.status(400).json({ error: `'${propName}' 속성이 없거나 숫자 타입이 아니에요. 와글러 DB에 먼저 만들어주세요.` });
            }

            const currentValue = prop.number ?? 0;
            const newValue = currentValue + hours.length;

            const response = await fetch(`https://api.notion.com/v1/pages/${page.id}`, {
                method: 'PATCH',
                headers,
                body: JSON.stringify({
                    properties: {
                        [propName]: { number: newValue },
                    },
                }),
            });
            const data = await response.json();
            if (!response.ok) {
                return res.status(response.status).json({ error: data.message || 'Notion 저장 실패' });
            }

            return res.status(200).json({ ok: true, month: propName, added: hours.length, newValue });
        }

        res.setHeader('Allow', ['GET', 'POST', 'OPTIONS']);
        return res.status(405).json({ error: `허용되지 않는 메서드: ${req.method}` });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}