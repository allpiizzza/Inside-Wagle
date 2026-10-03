// api/teamScores.js
// Vercel Serverless Function - 팀별 총점 집계 (전광판용)
//
// 와글러 DB의 '전체포인트'(formula) 컬럼이 각 와글러의 최종 총점입니다.
// (월포인트 + 주차 퀘스트 점수 + 프리덤 + 책구슬 포인트가 모두 이 formula에 이미 반영돼 있어요.)
// 그래서 요소를 재계산하지 않고 '전체포인트'를 그대로 읽어 팀별로 합산합니다 → Notion 값과 항상 일치.
// 와글러 DB 1회 스캔만 필요하고, 퀘스트 DB 조회는 더 이상 필요 없습니다.

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

// '팀'이 관계형일 때만 추가 조회가 일어남 (Select/Status면 호출 0회)
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

// 와글러 1명의 총점 = '전체포인트' 값 (formula/rollup/number 어느 형태든 숫자로 추출)
function extractTotalPoint(page) {
    const prop = page.properties['전체포인트'];
    if (!prop) return 0;
    if (prop.type === 'formula') return prop.formula?.number ?? 0;
    if (prop.type === 'rollup') return prop.rollup?.number ?? 0;
    if (prop.type === 'number') return prop.number ?? 0;
    return 0;
}

export default async function handler(req, res) {
    setCors(res);
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') {
        res.setHeader('Allow', ['GET', 'OPTIONS']);
        return res.status(405).json({ error: `허용되지 않는 메서드: ${req.method}` });
    }

    // 전광판은 실시간성이 크게 중요하지 않으니 60초 캐시 + 그 이후 59초는 예전 응답 보여주며 갱신
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=59');

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

        // 2) 팀 이름 맵 (팀이 관계형일 때만 추가 호출)
        const teamNameMap = await resolveRelationTitles(headers, pages, '팀');

        // 3) 팀별로 '전체포인트' 합산
        const teamMap = {}; // teamName -> { team, total, members: [{name, score}] }
        for (const page of pages) {
            const team = extractTeamName(page.properties['팀'], teamNameMap);
            if (!team) continue; // 팀 미배정은 전광판에서 제외
            const name = page.properties['와글러']?.title?.[0]?.plain_text || '이름없음';
            const score = extractTotalPoint(page);

            if (!teamMap[team]) teamMap[team] = { team, total: 0, members: [] };
            teamMap[team].total += score;
            teamMap[team].members.push({ name, score });
        }

        const teams = Object.values(teamMap)
            .map((t) => ({
                team: t.team,
                total: Math.round(t.total), // 정수로 반올림
                memberCount: t.members.length,
                members: t.members.sort((a, b) => b.score - a.score),
            }))
            .sort((a, b) => b.total - a.total); // 총점 내림차순

        return res.status(200).json(teams);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}
