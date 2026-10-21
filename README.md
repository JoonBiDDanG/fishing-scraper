# 낚시 일정 스냅샷 (GitHub Actions)

`app-debug.apk`(패키지 `com.example.squidfishing`)가 읽는 **`fishing_data.json`** 을
GitHub Actions 에서 주기적으로 만드는 저장소입니다.

앱은 공개 스냅샷 주소를 직접 읽습니다. 공개 저장소이므로 앱에 GitHub 토큰을 입력할 필요가 없습니다.

```
https://raw.githubusercontent.com/JoonBiDDanG/fishing-scraper/main/fishing_data.json
```

| 항목 | 값 |
| --- | --- |
| 저장소 | `JoonBiDDanG/fishing-scraper` |
| 브랜치 | `main` |
| 파일 | 저장소 루트의 `fishing_data.json` |

---

## 1. 데이터 출처

| 출처 | 방식 | 수집 내용 |
| --- | --- | --- |
| 선상24 | `api.sunsang24.com/ship/list` (JSON) | 날짜별 전국 선박 일정·출항시간·잔여석·어종 |
| 더피싱 | `thefishing.kr/reservation/list.php` (HTML) | 선박별 월간 예약표·출항시간·잔여석 |

두 곳을 직접 수집해 하나의 JSON 으로 합칩니다. 중간 집계 사이트나 별도 API 는 사용하지 않습니다.

---

## 2. 설치

1. 이 폴더의 내용을 `JoonBiDDanG/fishing-scraper` 저장소 루트에 올립니다.
   ```bash
   git clone https://github.com/JoonBiDDanG/fishing-scraper.git
   # 이 폴더의 파일들을 저장소 루트로 복사
   git add .
   git commit -m "feat: 선상24·더피싱 일정 수집 파이프라인"
   git push origin main
   ```
2. **Settings → Actions → General → Workflow permissions** 에서
   **Read and write permissions** 를 선택합니다.
3. **Actions** 탭 → `낚시 일정 스냅샷` → **Run workflow** 로 한 번 실행합니다.
4. 성공하면 `fishing_data.json` 과 `data/thefishing-ships.json` 이 커밋됩니다.
5. 새 낚시가자 APK를 설치하면 공개 일정이 자동으로 연결됩니다. 앱에 토큰을 입력하지 않아도 됩니다.

---

## 3. 동작 방식

- 워크플로는 **30분마다** 실행됩니다.
- 매 실행은 `오늘 ~ 오늘+2일`만 다시 수집합니다(근거리 갱신).
- **18시(UTC)** 실행과 수동 실행은 `오늘 ~ 오늘+14일` 전체를 수집합니다.
- 수집에 실패한 날짜·선박은 **기존 스냅샷 값을 그대로 유지**합니다.
- 전체 결과가 100건 미만이면 파일을 덮어쓰지 않고 실패로 끝냅니다.

```
scripts/crawl.mjs
 ├─ scripts/sources/sunsang.mjs      선상24 날짜별 API
 ├─ scripts/sources/thefishing.mjs   더피싱 선박별 월간 예약표
 └─ scripts/lib/http.mjs             재시도·동시성·WAF 감지
```

### 선상24 호출 제한

`/ship/list` 는 AWS WAF rate rule 이 적용되어 있습니다.
짧은 시간에 몰아서 호출하면 `405 Human Verification`(캡차)이 떨어집니다.

- 요청 간격을 **4.5초**로 강제합니다(`sunsangThrottleMs`, 5분당 약 67회).
- 실측: 3.2초 간격(5분당 94회)은 중간에 캡차가 떴고,
  4.5초 간격은 **450회 연속 수집을 끝까지 성공**했습니다.
- 캡차가 감지되면 선상24 수집을 **즉시 중단**하고, 더피싱 수집과 기존 스냅샷은 그대로 사용합니다.
- 전체 수집(약 450회 요청)은 약 35분, 근거리 수집(약 64회)은 약 5분 걸립니다.

---

## 4. 설정 (`config.json`)

```json
{
  "daysAhead": 14,
  "nearDays": 2,
  "species": ["주꾸미", "갑오징어"],
  "outputFile": "fishing_data.json",
  "registryFile": "data/thefishing-ships.json",
  "concurrency": 8,
  "sunsangThrottleMs": 3200,
  "sources": { "sunsang": true, "thefishing": true }
}
```

| 키 | 의미 |
| --- | --- |
| `daysAhead` | 오늘부터 며칠 뒤까지 저장할지 |
| `nearDays` | 매 실행마다 갱신할 근거리 일수 |
| `species` | 수집할 어종. 비우면 전체 |
| `concurrency` | 더피싱/외부 요청 동시 수 |
| `sunsangThrottleMs` | 선상24 요청 최소 간격(ms). 낮추면 차단 위험 |
| `sources` | 출처 on/off |

### 용량

실측 기준 전체 14일 스냅샷은 약 **3.8MB**(10,400건)입니다.
앱은 화면이 켜져 있는 동안 5분마다 파일을 다시 받으므로, 데이터를 아끼려면 `daysAhead` 를 줄이세요.

| daysAhead | 대략 |
| --- | --- |
| 7일 | 2.0MB |
| 14일 | 3.8MB |
| 21일 | 5.5MB |

---

## 5. 앱이 읽는 JSON 형식

루트에 `schedules` 배열이 있으면 됩니다. 앱은 `schedules` 가 없으면 `data` 키도 허용합니다.

```json
{
  "updatedAt": "2026-10-20T04:54:46.411Z",
  "minDate": "2026-10-20",
  "maxDate": "2026-11-03",
  "total": 10398,
  "schedules": [
    {
      "id": "sa:2020179",
      "boat": "빅포인트호",
      "boatId": "sa-2588",
      "source": "선상24",
      "speciesText": "주꾸미,갑오징어",
      "date": "2026-10-21",
      "region": "충남",
      "port": "내포항",
      "departure": "15:30",
      "remaining": 0,
      "status": "full",
      "url": "https://www.sunsang24.com/ship/schedule?ship_no=2588",
      "checkedAt": "2026-10-20T04:54:46.000Z",
      "latitude": 36.490963,
      "longitude": 126.40966
    }
  ]
}
```

앱이 실제로 읽는 키만 저장합니다.

| 키 | 앱 모델 |
| --- | --- |
| `id` | `FishingTrip.id` (문자열 해시) |
| `boat` | `operator` |
| `boatId` | `boatId` |
| `source` | `sourceLabel` |
| `speciesText` | `target` |
| `date` | `date` |
| `region` / `port` | `region` / `port` |
| `departure` | `openAt` |
| `remaining` | `seats` |
| `status` | 표시 상태 |
| `url` | `bookingUrl` |
| `checkedAt` | `checkedAt` |
| `latitude` / `longitude` | 바람지도 |

---

## 6. 로컬 실행

```bash
node scripts/crawl.mjs      # 수집
node scripts/verify.mjs     # 스키마·중복·날짜 검증
```

전체 수집을 강제하려면:

```bash
FULL_REFRESH=1 node scripts/crawl.mjs
```

PowerShell:

```powershell
$env:FULL_REFRESH='1'; node scripts/crawl.mjs
```

---

## 7. 문제 해결

| 증상 | 원인 | 대처 |
| --- | --- | --- |
| `405 Human Verification` | 선상24 WAF 캡차 | 1시간 정도 기다린 뒤 재실행. `sunsangThrottleMs` 를 5000 이상으로 |
| 선상24만 0건, 더피싱은 정상 | WAF 차단 | 기존 선상24 데이터가 유지됨. 다음 실행에서 재시도 |
| 앱에서 일정을 못 불러옴 | 공개 스냅샷 주소 또는 인터넷 연결 문제 | 저장소가 공개 상태인지, `fishing_data.json`에 `schedules`가 있는지 확인 |
| 앱 "파일 형식이 올바르지 않습니다" | `schedules` 없음 | `node scripts/verify.mjs` |
| 커밋이 안 됨 | Actions 권한 | Settings → Actions → Read and write |

---

## 8. 한계

- 더피싱은 목록 페이지에서 쭈꾸미·갑오징어를 취급하는 선박만 수집합니다(약 150척).
  선상24가 차단되면 전체 선박 수는 줄어들고, 기존에 수집된 선상24 일정은 유지됩니다.
- 선상24 WAF 정책이 강화되면 자동 수집이 어려울 수 있습니다. 이 경우 마지막 정상 스냅샷으로 앱은 계속 동작합니다.
- 앱의 실시간 좌석 확인·날씨 기능은 앱 자체 통신을 사용합니다. 이 저장소의 범위가 아닙니다.
