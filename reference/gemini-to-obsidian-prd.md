# PRD: Gemini-to-Obsidian Chrome Extension

> LLM 대화에서 생성된 MD 파일을 자동으로 conversation-to-note 스킬로 변환하여 Obsidian 볼트에 저장하는 크롬 확장프로그램

---

## 메타

| 항목 | 내용 |
|------|------|
| 프로젝트명 | gemini-to-obsidian |
| 버전 | v0.1.0 (MVP) |
| 작성일 | 2026-03-24 |
| 작성자 | 이영준 |
| 상태 | Draft |

---

## 1. 문제 정의

### 현재 상황

- Gemini, ChatGPT 등 웹 기반 LLM과 나누는 대화에서 유의미한 인사이트가 자주 발생함
- LLM에게 MD 파일로 정리를 요청하면 다운로드 링크를 제공하지만, 그 이후 과정이 수동임
  - 파일 다운로드 → 내용 열기 → 포맷 수정 → Obsidian inbox에 복붙 → Git push
- Claude Desktop App + conversation-to-note 스킬을 쓰면 한 번에 해결되지만, 다른 LLM 웹사이트에서는 적용 불가

### 목표 상태

- 웹 LLM에서 MD 파일이 생성되는 순간, 클릭 한 번으로 conversation-to-note 스킬이 발동되어 Obsidian 볼트의 `1-inbox/`에 저장됨
- 사용자는 Gemini에서 "MD로 정리해줘" → 파일 생성 확인 → 우클릭 "Save to Obsidian" 클릭으로 끝

---

## 2. 목표 사용자

- LLM 웹 서비스를 일상적으로 사용하는 PKM 실천자
- Obsidian + Git 기반 볼트를 사용하는 사용자
- Claude Desktop App의 conversation-to-note 스킬 사용 경험이 있는 사용자 (이영준)

---

## 3. 사용 시나리오 (Happy Path)

```
1. Gemini 웹사이트에서 대화 후 "이걸 MD 파일로 정리해줘" 요청
2. Gemini가 마크다운 파일 다운로드 링크 생성
3. 사용자가 확장프로그램 아이콘 클릭 또는 페이지 우클릭 → "Save to Obsidian" 클릭
4. 확장프로그램이 페이지에서 가장 마지막 다운로드 링크를 감지
5. 해당 링크 클릭 → 파일 내용 읽기
6. 파일 내용을 로컬 프록시 서버를 통해 Claude API에 전달
7. Claude API가 conversation-to-note 스킬에 따라 노트 포맷으로 변환
8. 변환된 내용을 Native File System API로 metanotes/1-inbox/ 에 저장
9. Git commit & push 자동 실행
10. 확장프로그램 팝업에서 성공 알림 표시
```

---

## 4. 기능 요구사항

### 4.1 핵심 기능 (MVP)

#### F-01: 다운로드 링크 감지
- **설명**: 현재 페이지에서 가장 최근에 생성된 `.md` 파일 다운로드 링크를 자동 감지
- **대상 사이트**: Gemini (gemini.google.com) — MVP 우선, 이후 확장
- **감지 방식**: DOM mutation observer로 `<a>` 태그의 href 또는 download 속성 모니터링
- **우선순위**: P0

#### F-02: 파일 내용 읽기
- **설명**: 감지된 링크를 fetch하여 MD 파일 텍스트 내용 추출
- **처리**: Blob URL 또는 data URL 형태 모두 처리
- **우선순위**: P0

#### F-03: conversation-to-note 변환 (Claude API 호출)
- **설명**: 읽은 MD 내용을 Claude API에 전달하여 conversation-to-note 스킬 포맷으로 변환
- **API 엔드포인트**: 로컬 프록시 서버 (`http://localhost:3847/convert`)
- **시스템 프롬프트**: conversation-to-note 스킬 전체 내용을 주입
- **입력**: 원본 MD 파일 내용
- **출력**: 변환된 노트 (YAML 프론트매터 + 본문)
- **우선순위**: P0

#### F-04: Obsidian 볼트 저장
- **설명**: 변환된 노트를 metanotes 볼트의 `1-inbox/` 폴더에 저장
- **저장 방식**: Native File System API (File System Access API)
- **파일명**: Claude API가 생성한 제목 기반 (`{제목}.md`)
- **첫 실행**: 사용자에게 볼트 폴더 선택 다이얼로그 표시 (이후 저장된 핸들 재사용)
- **우선순위**: P0

#### F-05: Git Sync
- **설명**: 파일 저장 후 자동으로 git pull → commit → push 실행
- **실행 방식**: 로컬 프록시 서버에 Git 명령 위임
- **우선순위**: P1

#### F-06: 확장프로그램 UI
- **팝업**: 현재 상태(대기/처리중/완료/에러), 마지막 저장된 노트 정보
- **우클릭 컨텍스트 메뉴**: "Save to Obsidian" 항목 노출
- **툴바 아이콘 뱃지**: 감지된 MD 링크 개수 표시
- **우선순위**: P0

### 4.2 확장 기능 (v0.2 이후)

- **F-07**: ChatGPT, Claude.ai 등 다른 LLM 사이트 지원
- **F-08**: 변환 전 미리보기 및 수동 편집 기능
- **F-09**: 저장 이력 로컬 보관
- **F-10**: Claude Code 앱 토큰 직접 활용 (구현 가능성 추가 검토 필요)

---

## 5. 아키텍처

### 5.1 컴포넌트 구성

```
┌─────────────────────────────────────────────────────┐
│                  Chrome Extension                   │
│                                                     │
│  ┌──────────────┐    ┌────────────────────────────┐ │
│  │ Content      │    │ Background Service Worker  │ │
│  │ Script       │───▶│  - 링크 감지 조율           │ │
│  │ (DOM 감지)   │    │  - 상태 관리               │ │
│  └──────────────┘    │  - API 호출 위임            │ │
│                      └────────────┬───────────────┘ │
│  ┌──────────────┐                 │                  │
│  │  Popup UI    │◀────────────────┘                  │
│  │  (상태 표시) │                                    │
│  └──────────────┘                                    │
└─────────────────────────┬───────────────────────────┘
                          │ HTTP (localhost only)
                          ▼
┌─────────────────────────────────────────────────────┐
│           Local Proxy Server (Node.js)              │
│           http://localhost:3847                     │
│                                                     │
│  POST /convert  ─────────────────▶ Claude API       │
│  POST /git-sync ─────────────────▶ child_process   │
│                                    (git pull/commit/push) │
└─────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────┐
│         metanotes Vault (Local Filesystem)          │
│         ~/path/to/metanotes/1-inbox/                │
│         (File System Access API 또는 프록시 경유)    │
└─────────────────────────────────────────────────────┘
```

### 5.2 로컬 프록시 서버 역할

크롬 확장프로그램은 보안 정책상 직접 Claude API 키를 보유하거나 로컬 파일시스템의 임의 경로에 접근하기 어렵다. 로컬 프록시 서버를 통해 이 문제를 해결한다.

| 역할 | 설명 |
|------|------|
| API 키 관리 | Claude API 키를 서버 환경변수로 관리 (확장에 노출 안 됨) |
| Claude Code 토큰 활용 | `~/.claude/` 토큰을 서버에서 읽어 API 재사용 가능 여부 추가 검토 |
| Git 명령 실행 | `child_process`로 git pull/commit/push 실행 |
| conversation-to-note 프롬프트 관리 | 스킬 내용을 서버에서 관리, 업데이트 용이 |

### 5.3 API 호출 흐름

```
확장프로그램
  → POST http://localhost:3847/convert
    {
      "content": "<MD 파일 원본 텍스트>",
      "source": "gemini"
    }
  
프록시 서버
  → Anthropic API /v1/messages
    {
      "model": "claude-sonnet-4-20250514",
      "system": "<conversation-to-note 스킬 전체>",
      "messages": [
        {
          "role": "user",
          "content": "아래 내용을 conversation-to-note 스킬 포맷으로 변환해줘:\n\n<MD 파일 내용>"
        }
      ]
    }

  ← 변환된 노트 반환 (YAML 프론트매터 포함 MD)

확장프로그램
  → File System Access API로 1-inbox/{제목}.md 저장
  → POST http://localhost:3847/git-sync
    { "vaultPath": "/path/to/metanotes", "fileName": "{제목}.md" }
```

---

## 6. 기술 스택

| 구분 | 기술 |
|------|------|
| 확장프로그램 | Manifest V3, Vanilla JS (또는 Preact for Popup) |
| 로컬 서버 | Node.js + Express |
| AI 변환 | Anthropic Claude API (`claude-sonnet-4-20250514`) |
| 파일 저장 | File System Access API (Chrome 86+) |
| Git 실행 | Node.js `child_process.exec` |
| 설정 저장 | `chrome.storage.local` |

---

## 7. 비기능 요구사항

| 항목 | 요구 수준 |
|------|-----------|
| 변환 속도 | API 호출 포함 30초 이내 완료 |
| 보안 | API 키는 로컬 서버에만 존재, 확장프로그램 코드에 하드코딩 금지 |
| 오프라인 | 로컬 서버 미실행 시 명확한 에러 메시지 표시 |
| 지원 브라우저 | Chrome 86+ (File System Access API 지원 버전) |
| 지원 OS | macOS 우선 (이영준 환경), Windows 추후 지원 |

---

## 8. 주요 제약 및 리스크

### 제약

| 제약 | 설명 | 해결 방향 |
|------|------|-----------|
| Manifest V3 Service Worker | 백그라운드에서 영구 실행 불가 | 이벤트 기반으로 설계, 상태는 `chrome.storage`에 보관 |
| File System Access API | 첫 실행 시 사용자 폴더 선택 필요 | 폴더 핸들을 `chrome.storage`에 직렬화하여 재사용 |
| CORS | 확장프로그램 → 로컬 서버 CORS 처리 필요 | 서버에서 `localhost` origin 허용 |
| Gemini DOM 구조 | 구글이 DOM 변경 시 링크 감지 로직 깨질 수 있음 | MutationObserver + 복수 셀렉터 fallback |

### 리스크

| 리스크 | 가능성 | 영향 | 대응 |
|--------|--------|------|------|
| Gemini의 MD 파일 제공 방식 변경 | 중 | 높음 | 감지 로직 모듈화, 셀렉터 외부 설정 파일로 분리 |
| Claude Code 토큰 재활용 불가 | 높음 | 낮음 | MVP는 별도 API 키 사용, 토큰 활용은 v0.2에서 검토 |
| File System Access API 권한 거부 | 낮음 | 중간 | 클립보드 복사 fallback 제공 |

---

## 9. 개발 로드맵

### Phase 0: 환경 설정 (1일)
- [ ] 크롬 확장프로그램 프로젝트 구조 생성 (Manifest V3)
- [ ] 로컬 프록시 서버 (Express) 기본 구조 생성
- [ ] conversation-to-note 스킬 프롬프트 서버에 탑재

### Phase 1: MVP 코어 (3~4일)
- [ ] Gemini 페이지 MD 링크 감지 (Content Script)
- [ ] 파일 fetch 및 텍스트 추출
- [ ] 프록시 서버 `/convert` 엔드포인트 (Claude API 호출)
- [ ] File System Access API로 볼트 저장
- [ ] 팝업 UI 기본 상태 표시

### Phase 2: Git Sync + UX (2~3일)
- [ ] 프록시 서버 `/git-sync` 엔드포인트
- [ ] 에러 처리 및 사용자 알림 개선
- [ ] 컨텍스트 메뉴 "Save to Obsidian" 구현
- [ ] 볼트 경로 설정 UI

### Phase 3: 안정화 (1~2일)
- [ ] Gemini DOM 변경 대응 테스트
- [ ] 엣지 케이스 처리 (링크 없음, 서버 미실행, API 오류)
- [ ] README 및 설치 가이드 작성

---

## 10. 폴더 구조 (제안)

```
gemini-to-obsidian/
├── extension/                    # 크롬 확장프로그램
│   ├── manifest.json
│   ├── background/
│   │   └── service-worker.js
│   ├── content/
│   │   └── gemini.js             # Gemini 페이지 전용 Content Script
│   ├── popup/
│   │   ├── popup.html
│   │   └── popup.js
│   └── icons/
│       ├── icon16.png
│       ├── icon48.png
│       └── icon128.png
│
└── proxy-server/                 # 로컬 프록시 서버
    ├── server.js
    ├── routes/
    │   ├── convert.js            # Claude API 호출
    │   └── git-sync.js           # Git 명령 실행
    ├── prompts/
    │   └── conversation-to-note.md   # 스킬 프롬프트
    ├── .env                      # ANTHROPIC_API_KEY
    └── package.json
```

---

## 11. 미결 사항 (Open Questions)

| # | 질문 | 결정 필요자 | 상태 |
|---|------|------------|------|
| OQ-1 | Claude Code 앱 토큰(`~/.claude/`) 구조 분석 후 재활용 가능 여부 | 이영준 | 미결 |
| OQ-2 | Gemini가 MD 파일을 항상 다운로드 링크로 제공하는지, 아니면 다른 방식도 있는지 | 이영준 | 미결 |
| OQ-3 | 프록시 서버를 PM2로 항상 실행 유지할지, 확장프로그램 실행 시 자동 기동할지 | 이영준 | 미결 |
| OQ-4 | 로컬 서버 포트 번호 고정(3847) vs 설정 가능하게 할지 | 이영준 | 미결 |

---

## 12. 참고

- [Manifest V3 공식 문서](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
- [File System Access API](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access)
- [Anthropic API 문서](https://docs.anthropic.com/en/api/messages)
- conversation-to-note 스킬: `/mnt/skills/user/conversation-to-note/SKILL.md`
