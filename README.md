# Inside-Wagle

# 기억구슬 보관방 - Notion 연동 설정 가이드

프론트(`index.html`, `registerMarble.html`, `quests.html`)와 API(`api/*.js`)를
**Vercel 하나에** 같이 배포하는 구조예요. GitHub Pages는 따로 필요 없어요.

## 1. 와글러 DB 만들기 (가장 먼저 만들어야 함 — 다른 DB들이 여길 참조해요)
- `와글러` — 제목(Title) 타입 (팀원 이름)
- `팀` — 단일 선택(Select) 타입, 옵션 5개 추가:
  생글이팀, 새침이팀, 포근이팀, 중심이팀, 불끈이팀
  (단일 선택 대신 다른 "팀" DB로 연결한 관계형(Relation)으로 만드셔도 괜찮아요 — 코드가 두 경우 다 자동으로 처리해요.
  다만 관계형으로 만드셨다면, **연결 대상인 팀 DB도 Integration과 공유(연결 추가)해줘야** 이름을 읽어올 수 있어요)
- `5월 포인트` — 숫자(Number) 타입
- `8월 1주차`, `8월 2주차`, `8월 3주차`, `8월 4주차`, ... 12월까지 — **관계형(Relation)** 타입, 대상 DB를 2번에서 만들 `퀘스트` DB로 지정
  (다중 선택이 아니라 관계형이어야 점수 자동 계산이 돼요. 화면에 보이는 모양은 태그처럼 비슷해요)
- 30명 명단을 미리 다 등록해두세요. **명단에 없는 이름으로 인증/등록하면 실패하도록** 만들어뒀어요.

## 2. 퀘스트 DB 만들기
- `퀘스트` — 제목(Title) 타입
- `현재진행여부` — 체크박스(Checkbox) 타입
- `달성조건` — 텍스트(Text) 타입
- `점수` — 숫자(Number) 타입

## 3. 기억구슬 DB 만들기
- `제목` — 제목(Title) 타입 (기본 Name 속성 이름을 "제목"으로 변경해도 됨)
- `와글러` — **관계형(Relation)** 타입, 대상 DB를 1번의 `와글러` DB로 지정
  (이름 텍스트 입력이 아니라 관계형이에요. 팀은 여기 따로 안 만들어도 돼요 —
  서버가 연결된 와글러 레코드에서 팀을 자동으로 찾아와요)
- `감정` — 다중 선택(Multi-select) 타입, 옵션 10개 추가:
  기쁨/유쾌, 슬픔/여운, 분노/답답, 스릴/소름, 까칠/찝찝, 뭉클/감동, 포근/힐링, 깨달음/지식, 허무/씁쓸, 설렘/달달

세 DB 모두 Integration과 연결(공유)해줘야 하고, 각각 URL에서 ID를 뽑아서
Vercel 환경변수에 넣어주면 돼요:
- `NOTION_WAGLER_DB_ID` = 와글러 DB의 ID
- `NOTION_QUEST_DB_ID` = 퀘스트 DB의 ID
- `NOTION_DATABASE_ID` = 기억구슬 DB의 ID

롤업 속성은 따로 안 만드셔도 돼요 — 점수 합산은 서버에서 매번 계산해서 보여줘요.

## 4. Notion Integration 만들기
1. https://www.notion.so/my-integrations 접속 → "New integration"
2. 이름 아무거나 지정 (예: wagle-marble-bot), 워크스페이스 선택 후 생성
3. 생성된 **Internal Integration Secret** 복사 (이게 `NOTION_TOKEN`)
4. 세 DB 페이지 각각 우측 상단 `···` → `연결 추가` → 방금 만든 integration 선택
   (이 단계를 빼먹으면 API가 그 DB에 접근 못 함 → "object_not_found" 에러)
5. 각 DB 페이지 URL 복사 (풀페이지 뷰의 주소창 그대로, 또는 `···` → 링크 복사)
   ```
   https://www.notion.so/워크스페이스명/1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p?v=xxxx
   ```
   `?v=` 앞에 있는 32자리 문자열이 그 DB의 ID (하이픈 있어도/없어도 무방)

## 5. 저장소(레포) 구조 만들기
GitHub에 새 레포를 만들고, 아래 구조로 그대로 push하세요.
**`api/` 폴더가 반드시 레포 최상위(root)에 있어야** Vercel이 서버리스 함수로 인식해요.

```
내-레포/
├── index.html            # 메인 랜딩
├── registerMarble.html   # 기억구슬 자판기 + 팀별 보관방
├── quests.html            # 퀘스트 인증 (팀/와글러/퀘스트/주차 선택)
└── api/
    ├── marbles.js          # 기억구슬 CRUD (기억구슬 DB)
    ├── questCatalog.js     # 퀘스트 목록 조회 (퀘스트 DB)
    ├── wagler.js            # 와글러 점수 조회 + 퀘스트 인증 추가 (와글러 DB)
    ├── weeks.js             # 와글러 DB에서 주차(관계형) 속성 이름만 조회
    └── waglerList.js        # 와글러 DB 명단(이름+팀) 조회 - 드롭다운용
```

## 6. Vercel 배포
1. https://vercel.com 에서 GitHub 계정으로 로그인 → 방금 만든 레포 import
2. 프레임워크는 자동 감지 안 되면 "Other"로 두면 됨 (설정 건드릴 것 없음)
3. Environment Variables에 추가:
    - `NOTION_TOKEN` = 4번에서 복사한 시크릿
    - `NOTION_DATABASE_ID` = 기억구슬 DB ID
    - `NOTION_QUEST_DB_ID` = 퀘스트 DB ID
    - `NOTION_WAGLER_DB_ID` = 와글러 DB ID
4. Deploy 클릭 → 끝나면 `https://프로젝트명.vercel.app` 하나로 프론트/API 다 열림

각 페이지의 API 호출은 이미 상대경로(`/api/...`)로 설정돼 있어서 따로 URL을 바꿔줄 필요 없어요.

## 참고
- 삭제는 Notion 특성상 완전 삭제가 아니라 "보관(archive)" 처리예요.
  Notion 워크스페이스 휴지통에서는 계속 보임 (완전 삭제하려면 Notion에서 직접 처리).
- 코드나 Notion DB 속성을 수정하고 다시 push하면 Vercel이 자동으로 재배포해요.
- Hobby(무료) 플랜 기준, 30명 규모 이벤트성 사용은 한도에 전혀 안 걸려요.
- `Notion-Version` 헤더는 날짜 형식(`2022-06-28`)이어야 해요. 임의의 값으로 바꾸면 API 요청이 전부 실패해요.