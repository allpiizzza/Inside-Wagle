// api/weeks.js
// Vercel Serverless Function - 와글러 DB의 "주차" 속성(관계형 타입) 이름 목록 조회
// 특정 인원을 조회하지 않고도 주차 드롭다운을 채울 수 있게 해줌

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
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=59');

    const NOTION_TOKEN = process.env.NOTION_TOKEN;
    const WAGLER_DB_ID = process.env.NOTION_WAGLER_DB_ID;

    if (!NOTION_TOKEN || !WAGLER_DB_ID) {
        return res.status(500).json({ error: '서버에 NOTION_TOKEN / NOTION_WAGLER_DB_ID 환경변수가 설정되지 않았어요.' });
    }

    try {
        const response = await fetch(`https://api.notion.com/v1/databases/${WAGLER_DB_ID}`, {
            headers: {
                Authorization: `Bearer ${NOTION_TOKEN}`,
                'Notion-Version': NOTION_VERSION,
            },
        });
        const data = await response.json();
        if (!response.ok) {
            return res.status(response.status).json({ error: data.message || '와글러 DB 스키마 조회 실패' });
        }

        const weeks = Object.entries(data.properties)
            .filter(([name, prop]) => prop.type === 'relation' && name.includes('주차'))
            .map(([name]) => name);

        return res.status(200).json(weeks);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}