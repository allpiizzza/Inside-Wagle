// 여러 페이지(quests/freedom/insidemacau/fortuneteller)가 같이 쓰는 공통 코드
// 각 페이지에서 <script src="/js/common.js"></script>로 불러와서 window.Wagle로 사용

(function () {
    // 제출에 성공한 팀/와글러 이름을 브라우저에 저장해두고 다음 방문 때 자동으로 채워줌
    // (시크릿 창 등 저장이 막힌 환경에서도 페이지가 멈추지 않도록 try/catch로 감쌈)
    const SAVED_TEAM_KEY = 'wagle.team';
    const SAVED_NAME_KEY = 'wagle.name';
    const LEGACY_NAME_KEY = 'rouletteUserName'; // 예전 insidemacau에서 쓰던 키

    function read(key) {
        try { return localStorage.getItem(key) || ''; } catch (e) { return ''; }
    }
    function write(key, value) {
        try { localStorage.setItem(key, value); } catch (e) {}
    }

    window.Wagle = {
        saved: {
            getTeam() { return read(SAVED_TEAM_KEY); }, // 예: "생글이팀"
            getName() { return read(SAVED_NAME_KEY) || read(LEGACY_NAME_KEY); },
            // 값이 비어있으면 기존 저장값을 그대로 둠
            save(team, name) {
                if (team) write(SAVED_TEAM_KEY, team);
                if (name) write(SAVED_NAME_KEY, name);
            },
        },
    };
})();
