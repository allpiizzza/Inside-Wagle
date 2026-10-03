// api/teamScores.js
// Vercel Serverless Function - 팀별 총점 집계 (전광판용)
// 와글러 DB를 1회, 퀘스트 DB를 1회 스캔해서 팀별로 점수를 합산합니다.
// 점수 정의는 wagler.js의 totalScore와 동일: (N월 포인트 숫자 합) + (주차 관계형이 가리키는 퀘스트 점수 합)
// 롤업/집계 속성을 Notion에 따로 만들 필요 없이 여기서 계산합니다.

const NOTION_VERSION = '2022-06-28';
const ALLOWED_ORIGIN = '*';

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// 퀘스트 DB를 훑어 { pageId: 점수 } 맵을 만듦
async function fetchQuestPointsMap(headers, questDbId) {
    const map = {};
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
            map[page.id] = page.properties['점수']?.number ?? 0;
        });
        cursor = data.has_more ? data.next_cursor : undefined;
    } while (cursor);
    return map;
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

// '팀'이 관계형일 때만 추가 조회가 일어남 (Select/Status면 호출 0회 → 더 효율적)
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

// 한 사람의 총점 = (N월 포인트 숫자 합) + (주차 관계형이 가리키는 퀘스트 점수 합)
function computePersonTotal(page, questPointsMap) {
    let total = 0;
    for (const [propName, prop] of Object.entries(page.properties)) {
        if (prop.type === 'number' && /\d+월\s*포인트/.test(propName)) {
            total += prop.number ?? 0;
        }
        if (prop.type === 'relation' && propName.includes('주차')) {
            total += prop.relation.reduce((sum, r) => sum + (questPointsMap[r.id] || 0), 0);
        }
    }
    return total;
}

export default async function handler(req, res) {
    setCors(res);
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') {
        res.setHeader('Allow', ['GET', 'OPTIONS']);
        return res.status(405).json({ error: `허용되지 않는 메서드: ${req.method}` });
    }

    // 전광판은 실시간성이 크게 중요하지 않으니 30초 캐시 + 그 이후 59초는 예전 응답 보여주며 갱신
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=59');

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
        // 1) 와글러 DB 전체 스캔
        const pages = [];
        let cursor = undefined;
        do {
            const response = await fetch(`https://api.notion.com/v1/databases/${WAGLER_DB_ID}/query`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ page_size: 100, start_cursor: cursor }),
            });
            const data = await response.json();
            if (!response.ok) {
                return res.status(response.status).json({ error: data.message || '와글러 DB 조회 실패' });
            }
            pages.push(...data.results);
            cursor = data.has_more ? data.next_cursor : undefined;
        } while (cursor);

        // 2) 퀘스트 점수 맵 + 팀 이름 맵(관계형일 때만 추가 호출)을 병렬로 준비
        const [questPointsMap, teamNameMap] = await Promise.all([
            fetchQuestPointsMap(headers, QUEST_DB_ID),
            resolveRelationTitles(headers, pages, '팀'),
        ]);

        // 3) 팀별로 묶어 합산
        const teamMap = {}; // teamName -> { team, total, members: [{name, score}] }
        for (const page of pages) {
            const team = extractTeamName(page.properties['팀'], teamNameMap);
            if (!team) continue; // 팀 미배정은 전광판에서 제외
            const name = page.properties['와글러']?.title?.[0]?.plain_text || '이름없음';
            const score = computePersonTotal(page, questPointsMap);

            if (!teamMap[team]) teamMap[team] = { team, total: 0, members: [] };
            teamMap[team].total += score;
            teamMap[team].members.push({ name, score });
        }

        const teams = Object.values(teamMap)
            .map((t) => ({
                ...t,
                memberCount: t.members.length,
                members: t.members.sort((a, b) => b.score - a.score),
            }))
            .sort((a, b) => b.total - a.total); // 총점 내림차순

        return res.status(200).json(teams);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}
