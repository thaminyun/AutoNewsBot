import fs from 'fs';
import Parser from 'rss-parser';
import { GoogleGenerativeAI } from '@google/generative-ai';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();
const parser = new Parser();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

// 1. 날짜 변환 함수 (YY-MM-DD)
function formatDate(dateStr) {
    try {
        if (!dateStr) return '';
        const d = new Date(dateStr);
        return d.toISOString().split('T')[0].substring(2); 
    } catch (e) { return ''; }
}

// 2. 24시간 필터링 함수
function isRecent(dateStr, timeWindow) {
    if (!dateStr) return false;
    const pubDate = new Date(dateStr).getTime();
    const now = Date.now();
    let maxAgeHours = 24; 
    if (timeWindow.includes('d')) maxAgeHours = parseInt(timeWindow) * 24;
    else if (timeWindow.includes('h')) maxAgeHours = parseInt(timeWindow);
    return (now - pubDate) <= (maxAgeHours * 60 * 60 * 1000);
}

// 3. HTML 태그 제거 함수
function cleanHtml(text) {
    if (!text) return '';
    return text.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

// ⭐ [신규] 언론사 명칭 추출 헬퍼 함수
function parseNewsItem(item, defaultSource) {
    let title = cleanHtml(item.title || '');
    let source = defaultSource;

    // 제목 끝에 " - 언론사명" 형식이 있는지 확인 (구글 뉴스 전형적 양식)
    const parts = title.split(' - ');
    if (parts.length > 1) {
        source = parts.pop().trim();
        title = parts.join(' - ').trim();
    }

    return { source, title };
}

// 4. 네이버 뉴스 수집
async function fetchNaverNews(keyword, timeWindow) {
    const clientId = process.env.NAVER_CLIENT_ID;
    const clientSecret = process.env.NAVER_CLIENT_SECRET;
    if (!clientId || !clientSecret) return [];

    const url = `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent('"' + keyword + '"')}&display=30&sort=date`;
    try {
        const response = await fetch(url, {
            headers: { 'X-Naver-Client-Id': clientId, 'X-Naver-Client-Secret': clientSecret }
        });
        const data = await response.json();
        if (!data.items) return [];

        return data.items
            .filter(item => isRecent(item.pubDate, timeWindow))
            .map(item => {
                const { source, title } = parseNewsItem(item, '네이버뉴스');
                return {
                    source, 
                    title, 
                    link: item.link, 
                    snippet: cleanHtml(item.description), 
                    date: formatDate(item.pubDate)
                };
            });
    } catch (e) { return []; }
}

// 5. 구글 뉴스 수집
async function safeFetchRSS(url) {
    try {
        const feed = await parser.parseURL(url);
        return feed.items;
    } catch (e) { return []; }
}

// ================= 메인 실행 함수 =================
async function main() {
    try {
        const windowCode = config.timeWindow.replace(/([0-9]+)([a-zA-Z]+)/, '$2$1');
        console.log(`🚀 뉴스 수집 시작 (검색 기간: ${config.timeWindow})`);
        
        const groupedNews = {};
        let totalArticles = 0;

        for (const keyword of config.keywords) {
            console.log(`\n🔍 [키워드: ${keyword}] 모수 수집 중...`);
            let keywordNews = [];

            const gnUrl = config.googleNewsApi.replace('{keyword}', encodeURIComponent('"' + keyword + '"')).replace('{window}', windowCode);
            const gnItems = await safeFetchRSS(gnUrl);
            const gnMapped = gnItems
                .filter(item => isRecent(item.pubDate, config.timeWindow))
                .slice(0, 20).map(item => {
                    const { source, title } = parseNewsItem(item, '구글뉴스');
                    return { 
                        source, 
                        title, 
                        link: item.link, 
                        snippet: cleanHtml(item.contentSnippet || '').substring(0, 150), 
                        date: formatDate(item.pubDate)
                    };
                });
            keywordNews = keywordNews.concat(gnMapped);

            const naverItems = await fetchNaverNews(keyword, config.timeWindow);
            keywordNews = keywordNews.concat(naverItems);

            const uniqueItems = [];
            keywordNews.forEach(item => {
                const isUrlDuplicate = uniqueItems.some(existing => existing.link === item.link);
                if (!isUrlDuplicate) uniqueItems.push(item);
            });
            
            groupedNews[keyword] = uniqueItems.slice(0, 25);
            totalArticles += groupedNews[keyword].length;
            console.log(`   - 1차 수집 완료: ${groupedNews[keyword].length}개 기사 확보`);
        }

        if (totalArticles === 0) {
            console.log("수집된 뉴스가 없습니다.");
            process.exit(0);
        }

        console.log(`\n🚀 AI 심층 분석 및 브리핑 생성 시작...`);
        const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });
        
        let finalHtmlContent = "";

        for (const keyword of config.keywords) {
            const items = groupedNews[keyword];
            if (items.length === 0) continue;

            let newsData = items.map((n, idx) => `[ID: ${idx}] [${n.source}] ${n.title}\n  (내용: ${n.snippet})`).join('\n\n');

            const prompt = `당신은 최고인사책임자(CHRO)이자 기업 전략가입니다. 아래는 '${keyword}' 키워드로 수집된 기사 목록입니다.

            [엄격한 업무 지침]
            1. 주제 심사: 기업 경영, 인사/노무, 조직 문화, 비즈니스 전략과 관련 없는 기사는 제외하세요.
            2. 지능형 중복 제거: 동일한 사건을 다룬 중복 기사는 가장 충실한 1개만 남기세요.
            3. 거시적 요약: 전체적인 흐름을 2~3줄로 거시적으로 요약하세요.
            4. 유의미한 기사가 없다면 "현재 수집된 유의미한 관련 기사가 없습니다."라고만 출력하세요.

            [출력 형식]
            순수한 JSON으로만 답하세요.
            {
              "summary": "거시적 요약 문구",
              "best_ids": [선택된 기사의 ID 숫자들 (최대 5개)]
            }
            
            [뉴스 데이터]
            ${newsData}`;
            
            const result = await model.generateContent(prompt);
            const responseText = result.response.text().trim();
            
            let aiResult;
            try {
                const jsonMatch = responseText.match(/\{[\s\S]*\}/);
                aiResult = JSON.parse(jsonMatch[0]);
            } catch (e) {
                aiResult = { summary: "AI 분석 중 오류가 발생했습니다.", best_ids: [] };
            }

            finalHtmlContent += `<h3>&lt;${keyword}&gt;</h3>\n<p>${aiResult.summary}</p>\n`;
            
            if (!aiResult.summary.includes("유의미한 관련 기사가 없")) {
                const selectedItems = aiResult.best_ids.map(id => items[id]).filter(item => item !== undefined);
                
                // ⭐ [업그레이드된 로직] 제목 제일 앞(괄호 무시)에 나오는 [단독] 기사만 최상단 끌어올리기
                selectedItems.sort((a, b) => {
                    // 정규식 설명: 문장 시작(^)에 공백이나 각종 괄호([, (, <, 【)가 0개 이상 있고, 바로 이어서 '단독'이 나오는 패턴
                    const exclusiveRegex = /^[\s\[\(<【]*단독/;
                    
                    const aExclusive = exclusiveRegex.test(a.title);
                    const bExclusive = exclusiveRegex.test(b.title);
                    
                    if (aExclusive && !bExclusive) return -1; // a가 진짜 단독 보도면 위로
                    if (!aExclusive && bExclusive) return 1;  // b가 진짜 단독 보도면 위로
                    return 0; // 둘 다 조건에 맞거나 둘 다 아니면 원래 순서 유지
                });

                selectedItems.forEach(n => {
                    finalHtmlContent += `<b>${n.source}</b> / ${n.date} / <a href="${n.link}" target="_blank" style="text-decoration:none; color:#1a73e8;">${n.title}</a><br>\n`;
                });
            }
            finalHtmlContent += `<br><br>\n`;
        }

        const transporter = nodemailer.createTransport({
            service: 'gmail', host: 'smtp.gmail.com', port: 465, secure: true,
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_APP_PASS }
        });

        await transporter.sendMail({
            from: process.env.EMAIL_USER, to: config.recipientEmail, subject: config.emailSubject, html: finalHtmlContent
        });

        console.log("✅ 브리핑 발송 완료!");
        process.exit(0); 

    } catch (error) {
        console.error("❌ 에러:", error);
        process.exit(1);
    }
}

main();
