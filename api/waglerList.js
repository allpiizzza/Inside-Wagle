// api/waglerList.js
// Vercel Serverless Function - 와글러 DB 명단(이름+팀)만 가져오는 용도
// 프론트에서 이름을 자유 입력받는 대신 드롭다운으로 고를 수 있게 해줌

const NOTION_VERSION = '2022-06-28';
const ALLOWED_ORIGIN = '*';

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function extractTeamName(prop, teamNameMap) {
    if (!prop) return null;
    if (prop.type === 'select') return prop.select?.name || null;
    if (prop.type === 'status') return prop.status?.name || null;
    if (prop.type === 'relation') {
        const id = prop.relation?.[0]?.id;
        return id ? (teamNameMap?.[id] || null) : null;
    }
    return null;
}

// '팀'이 관계형일 때, 연결된 페이지들의 제목(=팀 이름)을 가져와 {pageId: 이름} 맵으로 만듦
async function resolveRelationTitles(headers, pages, propName) {
    const idsNeeded = new Set();
    pages.forEach((page) => {
        const prop = page.properties[propName];
        if (prop?.type === 'relation') {
            prop.relation.forEach((r) => idsNeeded.add(r.id));
        }
    });
    const map = {};
    await Promise.all(
        [...idsNeeded].map(async (id) => {
            const resp = await fetch(`https://api.notion.com/v1/pages/${id}`, { headers });
            const data = await resp.json();
            if (resp.ok) {
                const titleProp = Object.values(data.properties || {}).find((p) => p.type === 'title');
                map[id] = titleProp?.title?.[0]?.plain_text || null;
            }
        })
    );
    return map;
}

export default async function handler(req, res) {
    setCors(res);
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') {
        res.setHeader('Allow', ['GET', 'OPTIONS']);
        return res.status(405).json({ error: `허용되지 않는 메서드: ${req.method}` });
    }

    // 명단이 자주 안 바뀌니 5분간 캐시, 그 이후 59초 동안은 예전 응답을 보여주면서 백그라운드로 갱신
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=59');

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
        const results = [];
        let cursor = undefined;
        do {
            const response = await fetch(`https://api.notion.com/v1/databases/${WAGLER_DB_ID}/query`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    sorts: [{ property: '와글러', direction: 'ascending' }],
                    page_size: 100,
                    start_cursor: cursor,
                }),
            });
            const data = await response.json();
            if (!response.ok) {
                return res.status(response.status).json({ error: data.message || 'Notion 조회 실패' });
            }
            results.push(...data.results);
            cursor = data.has_more ? data.next_cursor : undefined;
        } while (cursor);

        const teamNameMap = await resolveRelationTitles(headers, results, '팀');

        const waglers = results.map((page) => ({
            id: page.id,
            name: page.properties['와글러']?.title?.[0]?.plain_text || '이름없음',
            team: extractTeamName(page.properties['팀'], teamNameMap),
        }));

        return res.status(200).json(waglers);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}