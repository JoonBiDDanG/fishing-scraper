import requests
from bs4 import BeautifulSoup
import json
from datetime import datetime

# 수집할 타겟 사이트 목록
TARGET_SITES = [
    {
        "name": "선상24",
        "url": "https://www.sunsang24.com/", # 실제 선사 목록 페이지 URL로 수정 필요
        "selector": ".ship-item"             # 실제 HTML 태그 셀렉터로 수정 필요
    },
    {
        "name": "더피싱",
        "url": "https://www.thefishing.kr/", # 실제 주소로 수정
        "selector": ".fishing-card"
    },
    {
        "name": "클럽씨",
        "url": "https://www.clubsea.co.kr/",  # 실제 주소로 수정
        "selector": ".item-box"
    }
]

def scrape_site(site):
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    
    results = []
    try:
        print(f"[{site['name']}] 수집 시도 중...")
        response = requests.get(site["url"], headers=headers, timeout=10)
        response.raise_for_status()
        
        soup = BeautifulSoup(response.text, 'html.parser')
        items = soup.select(site["selector"])
        
        for item in items:
            # 예시 추출 로직 (실제 HTML 구조에 맞게 태그 변경 필요)
            title_elem = item.select_one('.title')
            seat_elem = item.select_one('.seat-count')
            
            title = title_elem.get_text(strip=True) if title_elem else "정보 없음"
            seats = seat_elem.get_text(strip=True) if seat_elem else "정보 없음"
            
            results.append({
                "platform": site["name"],
                "title": title,
                "seats": seats
            })
            
    except Exception as e:
        print(f"[{site['name']}] 수집 실패 오류: {e}")
        
    return results

if __name__ == "__main__":
    all_data = []
    
    for site in TARGET_SITES:
        site_data = scrape_site(site)
        all_data.extend(site_data)
        
    output = {
        "updated_at": datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        "data": all_data
    }
    
    # 결과를 JSON 파일로 저장 (GitHub 내에 자동 커밋됨)
    with open("fishing_data.json", "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=4)
        
    print(f"총 {len(all_data)}개의 데이터를 수집하여 파일로 저장했습니다.")