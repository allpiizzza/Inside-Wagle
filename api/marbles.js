// api/marbles.js
// Vercel Serverless Function - Notion API 프록시
// index.html과 같은 Vercel 프로젝트에서 함께 서빙되므로 CORS는 사실 없어도 되지만,
// 혹시 나중에 다른 도메인에서 이 API를 호출할 일이 생길 경우를 대비해 남겨뒀어요.
//
// '와글러'는 이제 자유 텍스트가 아니라 와글러 DB로의 관계형(Relation) 속성이라,
// 팀은 따로 입력받지 않고 연결된 와글러 레코드에서 자동으로 가져와요.

const NOTION_VERSION = '2022-06-28';
const ALLOWED_ORIGIN = '*';

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
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

async function fetchWaglerMap(headers, waglerDbId) {
    // pageId -> { name, team }
    const allPages = [];
    let cursor = undefined;
    do {
        const response = await fetch(`https://api.notion.com/v1/databases/${waglerDbId}/query`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ page_size: 100, start_cursor: cursor }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || '와글러 DB 조회 실패');
        allPages.push(...data.results);
        cursor = data.has_more ? data.next_cursor : undefined;
    } while (cursor);

    const teamNameMap = await resolveRelationTitles(headers, allPages, '팀');

    const map = {};
    allPages.forEach((page) => {
        map[page.id] = {
            name: page.properties['와글러']?.title?.[0]?.plain_text || '이름없음',
            team: extractTeamName(page.properties['팀'], teamNameMap),
        };
    });
    return map;
}

async function findWaglerByName(headers, waglerDbId, name) {
    const response = await fetch(`https://api.notion.com/v1/databases/${waglerDbId}/query`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            filter: { property: '와글러', title: { equals: name } },
            page_size: 1,
        }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || '와글러 DB 조회 실패');
    return data.results[0] || null;
}

export default async function handler(req, res) {
    setCors(res);

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const NOTION_TOKEN = process.env.NOTION_TOKEN;
    const DATABASE_ID = process.env.NOTION_DATABASE_ID;
    const WAGLER_DB_ID = process.env.NOTION_WAGLER_DB_ID;

    if (!NOTION_TOKEN || !DATABASE_ID || !WAGLER_DB_ID) {
        return res.status(500).json({ error: '서버에 NOTION_TOKEN / NOTION_DATABASE_ID / NOTION_WAGLER_DB_ID 환경변수가 설정되지 않았어요.' });
    }

    const headers = {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
    };

    try {
        // ---------- 목록 조회 ----------
        if (req.method === 'GET') {
            const response = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    sorts: [{ timestamp: 'created_time', direction: 'descending' }],
                    page_size: 100,
                }),
            });
            const data = await response.json();
            if (!response.ok) {
                return res.status(response.status).json({ error: data.message || 'Notion 조회 실패' });
            }

            const waglerMap = await fetchWaglerMap(headers, WAGLER_DB_ID);

            const marbles = data.results.map((page) => {
                const waglerId = page.properties['와글러']?.relation?.[0]?.id;
                const wagler = waglerId ? waglerMap[waglerId] : null;
                return {
                    id: page.id,
                    title: page.properties['책 제목']?.title?.[0]?.plain_text || '무제의 기억',
                    name: wagler?.name || '알 수 없음',
                    team: wagler?.team || null,
                    emotions: (page.properties['감정']?.multi_select || []).map((e) => e.name),
                };
            });

            return res.status(200).json(marbles);
        }

        // ---------- 생성 ----------
        if (req.method === 'POST') {
            const { title, name, emotions } = req.body || {};

            if (!Array.isArray(emotions) || emotions.length < 1 || emotions.length > 3) {
                return res.status(400).json({ error: '감정은 1~3개를 선택해야 해요.' });
            }
            if (!name || !name.trim()) {
                return res.status(400).json({ error: '이름을 입력해주세요.' });
            }

            const waglerPage = await findWaglerByName(headers, WAGLER_DB_ID, name.trim());
            if (!waglerPage) {
                return res.status(404).json({ error: '등록된 와글러 명단에 없어요. 이름을 다시 확인해주세요.' });
            }

            const response = await fetch('https://api.notion.com/v1/pages', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    parent: { database_id: DATABASE_ID },
                    properties: {
                        '책 제목': { title: [{ text: { content: (title || '무제의 기억').slice(0, 100) } }] },
                        와글러: { relation: [{ id: waglerPage.id }] },
                        감정: { multi_select: emotions.map((e) => ({ name: e })) },
                    },
                }),
            });
            const data = await response.json();
            if (!response.ok) {
                return res.status(response.status).json({ error: data.message || 'Notion 저장 실패' });
            }

            return res.status(200).json({ id: data.id });
        }

        // ---------- 삭제 (실제로는 Notion 페이지를 archive 처리) ----------
        if (req.method === 'DELETE') {
            const { id } = req.query;
            if (!id) {
                return res.status(400).json({ error: '삭제할 id가 필요해요.' });
            }

            const response = await fetch(`https://api.notion.com/v1/pages/${id}`, {
                method: 'PATCH',
                headers,
                body: JSON.stringify({ archived: true }),
            });
            const data = await response.json();
            if (!response.ok) {
                return res.status(response.status).json({ error: data.message || 'Notion 삭제 실패' });
            }

            return res.status(200).json({ ok: true });
        }

        res.setHeader('Allow', ['GET', 'POST', 'DELETE', 'OPTIONS']);
        return res.status(405).json({ error: `허용되지 않는 메서드: ${req.method}` });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}