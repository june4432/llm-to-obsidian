# LLM to Obsidian

Gemini 웹에서 생성된 마크다운 파일을 Claude API(conversation-to-note 스킬)로 변환하여 Obsidian 볼트의 `1-inbox/`에 자동 저장하는 Chrome 확장프로그램.

## 동작 흐름

```
Gemini 페이지 (MD 파일 감지)
    ↓ Chrome Extension (Content Script)
    ↓ 코드블록에서 마크다운 추출
    ↓ Service Worker → Native Messaging
    ↓
Python Script (convert_and_save.py)
    ├─ Claude API (Haiku) → conversation-to-note 변환
    ├─ 파일 저장 → {vault}/1-inbox/{제목}.md
    └─ Git pull → commit → push
```

## 설치 방법

### 1. 사전 요구사항

- Python 3.10+
- Git
- Chrome 브라우저
- Anthropic API 키

### 2. 저장소 클론

```bash
git clone <repository-url>
cd llm-to-obsidian
```

### 3. Python 의존성 설치

```bash
pip install -r host/requirements.txt
```

### 4. API 키 설정

```bash
cp host/.env.example host/.env
```

`host/.env` 파일을 열고 API 키를 입력:

```
ANTHROPIC_API_KEY=sk-ant-xxxxx
```

> Claude Code 앱 토큰(`sk-ant-oat01-`)도 사용 가능.

### 5. Chrome 확장프로그램 로드

1. Chrome에서 `chrome://extensions` 접속
2. **개발자 모드** 활성화 (우상단 토글)
3. **압축해제된 확장 프로그램을 로드합니다** 클릭
4. `extension/` 폴더 선택
5. 로드된 확장프로그램의 **ID를 복사** (예: `abcdefghijklmnop...`)

### 6. Native Messaging Host 등록

```bash
python install.py --extension-id 복사한_EXTENSION_ID
```

> Windows: 레지스트리에 자동 등록 + bat 래퍼 생성
> macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`에 manifest 생성

### 7. 볼트 경로 설정

1. Chrome 툴바에서 확장프로그램 아이콘 클릭
2. 하단 **Settings** 클릭
3. Obsidian 볼트 경로 입력 (예: `C:\Users\you\Documents\metanotes`)
4. **Save** 클릭

## 사용 방법

### 전체 흐름 (Request MD → Save)

1. Gemini에서 대화
2. 확장프로그램 아이콘 클릭 → **Request MD** 클릭
3. Gemini 입력창에 마크다운 정리 프롬프트가 자동 입력 + 전송됨
4. Gemini가 코드블록으로 마크다운 정리
5. 다시 확장프로그램 아이콘 클릭 → 감지된 MD 파일 목록 표시
6. 저장할 파일 체크 → **Save Selected** 클릭
7. 데스크톱 알림으로 완료/실패 표시

### 직접 요청 후 저장

1. Gemini에서 대화 후 직접 "이걸 MD 파일로 정리해줘" 요청
2. Gemini가 마크다운 파일 생성
3. 확장프로그램 아이콘 클릭 → **Save Selected** 클릭

### 우클릭 메뉴에서 저장

1. Gemini 페이지에서 우클릭
2. **Save to Obsidian** 클릭
3. 가장 마지막 마크다운 블록이 자동 저장됨

## 제거 방법

```bash
python install.py --uninstall
```

## 프로젝트 구조

```
llm-to-obsidian/
├── extension/                          # Chrome Extension (Manifest V3)
│   ├── manifest.json
│   ├── background/service-worker.js    # 메시지 라우팅, Native Messaging, 알림
│   ├── content/gemini.js               # Gemini DOM에서 MD 칩/코드블록 감지 및 추출
│   ├── popup/                          # 팝업 UI (파일 목록, 체크리스트, 로그)
│   └── icons/
│
├── host/                               # Native Messaging Host (Python)
│   ├── convert_and_save.py             # 메인 스크립트 (Claude API + 파일 저장 + Git sync)
│   ├── prompts/conversation-to-note.md # conversation-to-note 스킬 프롬프트
│   ├── requirements.txt
│   └── .env.example
│
├── install.py                          # Native Messaging Host 등록/해제 (Windows/macOS)
└── reference/                          # PRD, 스킬 파일 원본
```

## PRD 대비 변경사항

### 아키텍처 변경

| PRD 설계 | 실제 구현 | 이유 |
|----------|----------|------|
| Express 상시 서버 (localhost:3847) | **Native Messaging + Python 스크립트** | 서버 상시 실행 불필요, 자원 절약 |
| Node.js + child_process (Git) | **Python + subprocess** | 단일 언어로 통합 (API 호출 + Git) |
| File System Access API (파일 저장) | **Python 직접 저장** | 별도 파일 선택 다이얼로그 불필요 |
| claude-sonnet-4 모델 | **claude-haiku-4-5** | OAuth 앱 토큰 호환성, 비용 절감 |

### 추가된 기능 (PRD에 없던 것)

| 기능 | 설명 |
|------|------|
| **Request MD 자동 프롬프트** | 팝업에서 클릭 한 번으로 Gemini에 마크다운 정리 프롬프트 자동 입력 + 전송 |
| **다중 MD 파일 선택** | 페이지의 MD 파일을 체크리스트로 표시, 선택 저장 |
| **Gemini sandbox 파일 지원** | `sandbox:` URL의 MD 칩 감지 + 코드블록 추출 |
| **Python 래퍼 자동 제거** | `content = """..."""` 형태의 Python 코드에서 마크다운만 추출 |
| **Content Script 자동 주입** | 확장프로그램 리로드 후 페이지 새로고침 없이 동작 |
| **Test Connection** | 팝업에서 Python 환경, API 키, Git, 볼트 경로 진단 |
| **디버그 로그** | 팝업 하단 실시간 로그 + `host/debug.log` 파일 |
| **Windows 알림** | 저장 성공/실패 시 Windows 데스크톱 알림 |
| **배지 상태 표시** | 처리중(...), 완료(OK), 에러(!) 배지 |
| **Windows/macOS 동시 지원** | install.py가 OS별 Native Messaging 등록 자동 분기 |

### PRD 미결사항 해소

| 미결사항 | 해소 내용 |
|----------|----------|
| OQ-1: Claude Code 앱 토큰 재활용 | `sk-ant-oat01-` 토큰 사용 가능 (Haiku 모델 한정) |
| OQ-2: Gemini MD 제공 방식 | `sandbox:` URL + `data-test-id="file-name"` 칩 형태, 직접 다운로드 불가 → 코드블록 추출 방식 채택 |
| OQ-3: 서버 실행 방식 | Native Messaging으로 해결 — 서버 불필요, 필요 시 자동 실행 |
| OQ-4: 포트 번호 | 서버 없으므로 해당 없음 |

## 트러블슈팅

### "Specified native messaging host not found"
- `python install.py --extension-id YOUR_ID` 실행 여부 확인
- Extension ID가 정확한지 확인 (`chrome://extensions`에서 복사)

### "No API key found"
- `host/.env` 파일에 `ANTHROPIC_API_KEY` 설정 확인

### "Content script not loaded"
- Gemini 페이지를 새로고침(F5)하거나, 확장프로그램 팝업의 **Rescan Page** 클릭

### 저장이 오래 걸림 (~30초)
- Claude API 호출 ~18초 + Git sync ~7초가 기본 소요
- 네트워크 상태에 따라 변동

## 라이선스

MIT
