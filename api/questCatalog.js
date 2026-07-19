// api/questCatalog.js
// Vercel Serverless Function - 퀘스트 목록 DB 조회 전용 (읽기만 함)

const NOTION_VERSION = '2022-06-28';
const ALLOWED_ORIGIN = '*';

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
    setCors(res);
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') {
        res.setHeader('Allow', ['GET', 'OPTIONS']);
        return res.status(405).json({ error: `허용되지 않는 메서드: ${req.method}` });
    }
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=59');

    const NOTION_TOKEN = process.env.NOTION_TOKEN;
    const QUEST_DB_ID = process.env.NOTION_QUEST_DB_ID;

    if (!NOTION_TOKEN || !QUEST_DB_ID) {
        return res.status(500).json({ error: '서버에 NOTION_TOKEN / NOTION_QUEST_DB_ID 환경변수가 설정되지 않았어요.' });
    }

    const headers = {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
    };

    try {
        const results = [];
        let cursor = undefined;
        const activeOnly = req.query.active === 'true';

        // 100개 넘을 수도 있으니 페이지네이션 처리
        do {
            const response = await fetch(`https://api.notion.com/v1/databases/${QUEST_DB_ID}/query`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    page_size: 100,
                    start_cursor: cursor,
                    ...(activeOnly ? { filter: { property: '현재진행여부', checkbox: { equals: true } } } : {}),
                }),
            });
            const data = await response.json();
            if (!response.ok) {
                return res.status(response.status).json({ error: data.message || 'Notion 조회 실패' });
            }
            results.push(...data.results);
            cursor = data.has_more ? data.next_cursor : undefined;
        } while (cursor);

        const quests = results.map((page) => ({
            id: page.id,
            name: page.properties['퀘스트']?.title?.[0]?.plain_text || '이름없음',
            active: page.properties['현재 진행중']?.checkbox ?? false,
            condition: page.properties['달성조건']?.rich_text?.[0]?.plain_text || '',
            points: page.properties['점수']?.number ?? 0,
        }));

        return res.status(200).json(quests);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}