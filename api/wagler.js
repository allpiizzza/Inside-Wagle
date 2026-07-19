// api/wagler.js
// Vercel Serverless Function - 와글러(팀원) DB 조회/업데이트
// 인증 제출 시 팀/와글러/퀘스트/주차 4개를 골라, 해당 주차(관계형 속성)에 퀘스트 1개를 추가합니다.
// 롤업 속성을 Notion에 따로 만들 필요 없이, 여기서 매번 계산해서 내려줍니다.

const NOTION_VERSION = '2022-06-28';
const ALLOWED_ORIGIN = '*';

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function fetchQuestPointsMap(headers, questDbId) {
    const map = {}; // pageId -> { name, points }
    let cursor = undefined;
    do {
        const response = await fetch(`https://api.notion.com/v1/databases/${questDbId}/query`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ page_size: 100, start_cursor: cursor }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || '퀘스트 DB 조회 실패');
        data.results.forEach((page) => {
            map[page.id] = {
                name: page.properties['퀘스트']?.title?.[0]?.plain_text || '이름없음',
                points: page.properties['점수']?.number ?? 0,
            };
        });
        cursor = data.has_more ? data.next_cursor : undefined;
    } while (cursor);
    return map;
}

async function findWaglerPage(headers, waglerDbId, name, team) {
    const andFilters = [
        { property: '와글러', title: { equals: name } },
    ];
    if (team) {
        andFilters.push({ property: '팀', select: { equals: team } });
    }
    const response = await fetch(`https://api.notion.com/v1/databases/${waglerDbId}/query`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ filter: { and: andFilters }, page_size: 1 }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || '와글러 DB 조회 실패');
    return data.results[0] || null;
}

function extractWeeks(page, questPointsMap) {
    const weeks = [];
    for (const [propName, prop] of Object.entries(page.properties)) {
        if (prop.type !== 'relation') continue;
        const questIds = prop.relation.map((r) => r.id);
        const questNames = questIds.map((id) => questPointsMap[id]?.name || '(삭제된 퀘스트)');
        const weekPoints = questIds.reduce((sum, id) => sum + (questPointsMap[id]?.points || 0), 0);
        weeks.push({ name: propName, questIds, questNames, points: weekPoints });
    }
    return weeks;
}

export default async function handler(req, res) {
    setCors(res);
    if (req.method === 'OPTIONS') return res.status(200).end();

    const NOTION_TOKEN = process.env.NOTION_TOKEN;
    const WAGLER_DB_ID = process.env.NOTION_WAGLER_DB_ID;
    const QUEST_DB_ID = process.env.NOTION_QUEST_DB_ID;

    if (!NOTION_TOKEN || !WAGLER_DB_ID || !QUEST_DB_ID) {
        return res.status(500).json({ error: '서버에 NOTION_TOKEN / NOTION_WAGLER_DB_ID / NOTION_QUEST_DB_ID 환경변수가 설정되지 않았어요.' });
    }

    const headers = {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
    };

    try {
        // ---------- 내 정보 + 주차별 현황 조회 ----------
        if (req.method === 'GET') {
            const name = (req.query.name || '').trim();
            const team = (req.query.team || '').trim();
            if (!name) return res.status(400).json({ error: '이름을 입력해주세요.' });

            const page = await findWaglerPage(headers, WAGLER_DB_ID, name, team || undefined);
            if (!page) {
                return res.status(404).json({ error: '등록된 와글러 명단에 없어요. 이름/팀을 다시 확인해주세요.' });
            }

            const questPointsMap = await fetchQuestPointsMap(headers, QUEST_DB_ID);
            const weeks = extractWeeks(page, questPointsMap);
            const mayPoints = page.properties['5월 포인트']?.number ?? 0;
            const totalScore = mayPoints + weeks.reduce((sum, w) => sum + w.points, 0);

            return res.status(200).json({
                pageId: page.id,
                name: page.properties['와글러']?.title?.[0]?.plain_text || name,
                team: page.properties['팀']?.select?.name || null,
                mayPoints,
                weeks,
                totalScore,
            });
        }

        // ---------- 특정 주차에 퀘스트 1개 인증(추가) ----------
        if (req.method === 'POST') {
            const { name, team, week, questId } = req.body || {};
            if (!name || !name.trim()) return res.status(400).json({ error: '와글러 이름을 입력해주세요.' });
            if (!team || !team.trim()) return res.status(400).json({ error: '팀을 선택해주세요.' });
            if (!week || !week.trim()) return res.status(400).json({ error: '주차를 선택해주세요.' });
            if (!questId || !questId.trim()) return res.status(400).json({ error: '퀘스트를 선택해주세요.' });

            const page = await findWaglerPage(headers, WAGLER_DB_ID, name.trim(), team.trim());
            if (!page) {
                return res.status(404).json({ error: '등록된 와글러 명단에 없어요. 팀/이름을 다시 확인해주세요.' });
            }

            const weekProp = page.properties[week];
            if (!weekProp || weekProp.type !== 'relation') {
                return res.status(400).json({ error: `'${week}' 속성을 찾을 수 없거나 관계형 속성이 아니에요.` });
            }

            const currentIds = weekProp.relation.map((r) => r.id);
            if (currentIds.includes(questId)) {
                return res.status(200).json({ ok: true, alreadyExists: true });
            }

            const response = await fetch(`https://api.notion.com/v1/pages/${page.id}`, {
                method: 'PATCH',
                headers,
                body: JSON.stringify({
                    properties: {
                        [week]: { relation: [...currentIds, questId].map((id) => ({ id })) },
                    },
                }),
            });
            const data = await response.json();
            if (!response.ok) {
                return res.status(response.status).json({ error: data.message || 'Notion 저장 실패' });
            }

            return res.status(200).json({ ok: true, added: true });
        }

        res.setHeader('Allow', ['GET', 'POST', 'OPTIONS']);
        return res.status(405).json({ error: `허용되지 않는 메서드: ${req.method}` });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}