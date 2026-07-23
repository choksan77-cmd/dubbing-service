# 번역더빙 서비스 — 1단계: 배포 파이프라인

이 폴더는 Next.js 최소 프로젝트입니다. 목표는 "화면 내용"이 아니라
**GitHub → Railway 자동 배포가 실제로 작동하는지 확인**하는 것입니다.

## 1. GitHub에 올리기

1. https://github.com 에 로그인 (이미 가입해두신 계정)
2. 우측 상단 `+` → `New repository` 클릭
3. Repository name: `dubbing-service` 입력 → `Create repository`
4. 이 폴더에서 터미널을 열고 아래 명령어 실행 (Claude Code를 쓰면 이 부분을 대신 실행해줄 수 있습니다)

```bash
git init
git add .
git commit -m "init: 프로젝트 초기 세팅"
git branch -M main
git remote add origin https://github.com/내깃허브아이디/dubbing-service.git
git push -u origin main
```

## 2. Railway에 배포하기

1. https://railway.app 접속 → GitHub 계정으로 로그인
2. `New Project` → `Deploy from GitHub repo` 선택
3. 방금 만든 `dubbing-service` 저장소 선택
4. Railway가 Next.js 프로젝트를 자동 인식해서 빌드/배포를 시작합니다
5. 배포가 끝나면 Railway가 자동으로 만들어주는 URL(예: `xxxx.up.railway.app`)로 접속해서
   "번역더빙 서비스" 문구가 뜨는지 확인

이 화면이 뜨면 배포 파이프라인 1단계는 완료입니다.
이후 단계(회원가입, DB 연결, 영상 처리 파이프라인)는 이 위에 하나씩 이어서 붙여나가면 됩니다.

## 참고

- 로컬에서 미리 확인하려면: `npm install` → `npm run dev` → http://localhost:3000
- 코드/설계 관련 질문은 Claude Code에서 이 폴더를 열고 이어서 진행하시면 됩니다.
