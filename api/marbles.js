// api/marbles.js
// Vercel Serverless Function - Notion API 프록시
// index.html과 같은 Vercel 프로젝트에서 함께 서빙되므로 CORS는 사실 없어도 되지만,
// 혹시 나중에 다른 도메인에서 이 API를 호출할 일이 생길 경우를 대비해 남겨뒀어요.

const NOTION_VERSION = '2022-06-28';
const ALLOWED_ORIGIN = '*';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const DATABASE_ID = process.env.NOTION_DATABASE_ID;

  if (!NOTION_TOKEN || !DATABASE_ID) {
    return res.status(500).json({ error: '서버에 NOTION_TOKEN / NOTION_DATABASE_ID 환경변수가 설정되지 않았어요.' });
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

      const marbles = data.results.map((page) => ({
        id: page.id,
        title: page.properties['제목']?.title?.[0]?.plain_text || '무제의 기억',
        name: page.properties['작성자']?.rich_text?.[0]?.plain_text || '익명',
        team: page.properties['팀']?.select?.name || null,
        emotions: (page.properties['감정']?.multi_select || []).map((e) => e.name),
      }));

      return res.status(200).json(marbles);
    }

    // ---------- 생성 ----------
    if (req.method === 'POST') {
      const { title, name, team, emotions } = req.body || {};

      if (!Array.isArray(emotions) || emotions.length < 1 || emotions.length > 3) {
        return res.status(400).json({ error: '감정은 1~3개를 선택해야 해요.' });
      }
      if (!name || !name.trim()) {
        return res.status(400).json({ error: '이름을 입력해주세요.' });
      }
      if (!team || !team.trim()) {
        return res.status(400).json({ error: '팀을 선택해주세요.' });
      }

      const response = await fetch('https://api.notion.com/v1/pages', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          parent: { database_id: DATABASE_ID },
          properties: {
            제목: { title: [{ text: { content: (title || '무제의 기억').slice(0, 100) } }] },
            작성자: { rich_text: [{ text: { content: name.trim().slice(0, 30) } }] },
            팀: { select: { name: team.trim() } },
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
