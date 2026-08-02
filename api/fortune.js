// api/fortune.js
// Vercel Serverless Function - 와글의 운세 데이터 조회 전용 (읽기만 함)
// 기존 구글 시트(SCRIPT_URL)를 대체해 Notion DB 2개(인용/아이템)를 읽어 { quotes, items } 형태로 돌려줌

const NOTION_VERSION = '2022-06-28';
const ALLOWED_ORIGIN = '*';

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// 페이지에서 대표 텍스트를 뽑음.
// DB마다 컬럼명이 다를 수 있어 이름에 의존하지 않고 title 속성을 우선 사용,
// 없으면 첫 rich_text 속성으로 대체함. (title은 여러 조각으로 나뉠 수 있어 join)
function pageToText(page) {
    const props = Object.values(page.properties || {});
    const titleProp = props.find((p) => p.type === 'title');
    if (titleProp) return titleProp.title.map((t) => t.plain_text).join('');
    const richTextProp = props.find((p) => p.type === 'rich_text');
    if (richTextProp) return richTextProp.rich_text.map((t) => t.plain_text).join('');
    return '';
}

// DB 하나를 전부 읽어(페이지네이션 포함) 텍스트 배열로 변환
async function queryAllTexts(headers, dbId) {
    const texts = [];
    let cursor = undefined;
    do {
        const response = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ page_size: 100, start_cursor: cursor }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Notion 조회 실패');

        for (const page of data.results) {
            const text = pageToText(page).trim();
            if (text) texts.push(text);
        }
        cursor = data.has_more ? data.next_cursor : undefined;
    } while (cursor);
    return texts;
}

export default async function handler(req, res) {
    setCors(res);
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') {
        res.setHeader('Allow', ['GET', 'OPTIONS']);
        return res.status(405).json({ error: `허용되지 않는 메서드: ${req.method}` });
    }
    // 자주 안 바뀌는 데이터라 5분 캐시, 이후 59초 동안은 예전 응답 보여주며 백그라운드 갱신
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=59');

    const NOTION_TOKEN = process.env.NOTION_TOKEN;
    const QUOTES_DB_ID = process.env.NOTION_FORTUNE_QUOTES_DB_ID;
    const ITEMS_DB_ID = process.env.NOTION_FORTUNE_ITEMS_DB_ID;

    if (!NOTION_TOKEN || !QUOTES_DB_ID || !ITEMS_DB_ID) {
        return res.status(500).json({
            error: '서버에 NOTION_TOKEN / NOTION_FORTUNE_QUOTES_DB_ID / NOTION_FORTUNE_ITEMS_DB_ID 환경변수가 설정되지 않았어요.',
        });
    }

    const headers = {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
    };

    try {
        // 두 DB를 동시에 조회
        const [quoteTexts, itemTexts] = await Promise.all([
            queryAllTexts(headers, QUOTES_DB_ID),
            queryAllTexts(headers, ITEMS_DB_ID),
        ]);

        // 기존 프론트(fortuneteller.html)가 읽던 형태에 맞춤:
        //   quotes 항목은 .text, items 항목은 .name 으로 접근함
        const quotes = quoteTexts.map((text) => ({ text }));
        const items = itemTexts.map((name) => ({ name }));

        return res.status(200).json({ quotes, items });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}
