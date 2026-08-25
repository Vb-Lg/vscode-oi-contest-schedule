const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// 本地化翻译表（与 PHP 版本一致）
const translations = {
  zh: {
    htmlLang: 'zh-CN',
    pageTitle: '信息竞赛日程',
    heading: '信息竞赛日程',
    upcomingTitle: '即将到来的信息竞赛',
    finishedTitle: '已结束的信息竞赛',
    loadError: '暂时无法加载赛事数据，请稍后再试。',
    finishedLoadError: '暂时无法加载已结束赛事数据，请稍后再试。',
    emptyUpcoming: '暂无即将开始的赛事。',
    emptyFinished: '暂无最近结束的赛事。',
    ended: '已结束',
    running: '进行中',
    timezoneLabel: '时区',
    lastUpdatedLabel: '最后更新时间',
    day: '天',
    hour: '时',
    minute: '分',
    second: '秒'
  },
  en: {
    htmlLang: 'en',
    pageTitle: 'OI Contest Schedule',
    heading: 'OI Contest Schedule',
    upcomingTitle: 'Upcoming Contests',
    finishedTitle: 'Finished Contests',
    loadError: 'Contest data is temporarily unavailable. Please try again later.',
    finishedLoadError: 'Finished contest data is temporarily unavailable. Please try again later.',
    emptyUpcoming: 'No upcoming contests.',
    emptyFinished: 'No recently finished contests.',
    ended: 'Ended',
    running: 'Running',
    timezoneLabel: 'Time zone',
    lastUpdatedLabel: 'Last updated',
    day: 'd',
    hour: 'h',
    minute: 'm',
    second: 's'
  }
};

function normalizeLanguage(lang) {
  lang = (lang || '').toLowerCase();
  if (lang.startsWith('zh')) return 'zh';
  if (lang.startsWith('en')) return 'en';
  return 'en';
}

function detectLanguage() {
  // 优先使用 VS Code 语言设置
  const configLang = vscode.env.language;
  return normalizeLanguage(configLang);
}

function detectTimezone() {
  // 从配置读取，若为空则尝试系统时区
  const config = vscode.workspace.getConfiguration('oiContestSchedule');
  const configuredTz = config.get('timezone', '');
  if (configuredTz) {
    try {
      // 验证时区是否有效
      new Intl.DateTimeFormat('en', { timeZone: configuredTz });
      return configuredTz;
    } catch (e) {
      console.warn(`Invalid timezone: ${configuredTz}, falling back to system timezone.`);
    }
  }
  // 自动检测系统时区
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch (e) {
    return 'UTC';
  }
}

// 获取远程 JSON（支持 http/https，带缓存）
function fetchWithCache(url, cacheMinutes) {
  return new Promise((resolve, reject) => {
    const cacheFile = path.join(__dirname, '.cache', 'contests.json');
    const cacheDir = path.dirname(cacheFile);
    
    // 检查缓存
    if (cacheMinutes > 0 && fs.existsSync(cacheFile)) {
      const stat = fs.statSync(cacheFile);
      const ageMinutes = (Date.now() - stat.mtimeMs) / 60000;
      if (ageMinutes < cacheMinutes) {
        fs.readFile(cacheFile, 'utf8', (err, data) => {
          if (!err) return resolve(data);
        });
        return;
      }
    }

    // 发起请求
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let rawData = '';
      res.on('data', chunk => rawData += chunk);
      res.on('end', () => {
        // 尝试解析 JSON 验证
        try {
          JSON.parse(rawData);
          // 写入缓存
          if (cacheMinutes > 0) {
            fs.mkdirSync(cacheDir, { recursive: true });
            fs.writeFile(cacheFile, rawData, err => {});
          }
          resolve(rawData);
        } catch (e) {
          // JSON 无效，尝试读取旧缓存
          if (fs.existsSync(cacheFile)) {
            fs.readFile(cacheFile, 'utf8', (err, data) => resolve(data));
          } else {
            reject(e);
          }
        }
      });
    });
    req.on('error', (err) => {
      // 网络错误，尝试读旧缓存
      if (fs.existsSync(cacheFile)) {
        fs.readFile(cacheFile, 'utf8', (readErr, data) => {
          if (!readErr) resolve(data);
          else reject(err);
        });
      } else {
        reject(err);
      }
    });
    req.setTimeout(20000, () => req.destroy());
  });
}

function parseContestPayload(json) {
  const data = JSON.parse(json);
  if (!data || typeof data !== 'object') return null;
  let contests = [];
  let generatedAt = 0;
  if (Array.isArray(data.contests)) {
    contests = data.contests;
    generatedAt = data.generated_at || 0;
  } else if (Array.isArray(data)) {
    contests = data;
  } else {
    return null;
  }
  return { contests, generatedAt };
}

function splitContests(all) {
  const upcoming = [];
  const finished = [];
  for (const c of all) {
    if (c.status === 'finished') finished.push(c);
    else upcoming.push(c);
  }
  upcoming.sort((a, b) => (a.start_time || 0) - (b.start_time || 0));
  finished.sort((a, b) => (a.end_time || 0) - (b.end_time || 0));
  return { upcoming, finished };
}

function getWebviewContent(webview, context, payload) {
  const { contests, generatedAt } = payload;
  const lang = detectLanguage();
  const t = translations[lang];
  const timezone = detectTimezone();

  // 将数据注入到 HTML 中
  const dataScript = `
    window.contestsData = ${JSON.stringify(contests)};
    window.generatedAt = ${JSON.stringify(generatedAt)};
    window.translations = ${JSON.stringify(t)};
    window.serverLanguage = ${JSON.stringify(lang)};
    window.serverTimezone = ${JSON.stringify(timezone)};
  `;

  // 读取 webview.html 并替换占位符
  const htmlPath = path.join(context.extensionPath, 'media', 'webview.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  return html.replace('<!-- DATA_SCRIPT -->', `<script>${dataScript}</script>`);
}

function activate(context) {
  console.log('OI Contest Schedule extension activated');

  let disposable = vscode.commands.registerCommand('oiContestSchedule.show', async () => {
    // 创建 Webview Panel
    const panel = vscode.window.createWebviewPanel(
      'oiContestSchedule',
      'OI Contest Schedule',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))]
      }
    );

    // 设置初始内容
    const config = vscode.workspace.getConfiguration('oiContestSchedule');
    const jsonUrl = config.get('jsonUrl', 'https://raw.githubusercontent.com/hanyixuanten/OI-contest-fetch/master/contests_all.json');
    const cacheMinutes = config.get('cacheMinutes', 5);

    panel.webview.html = '<p>Loading...</p>';

    try {
      const json = await fetchWithCache(jsonUrl, cacheMinutes);
      const payload = parseContestPayload(json);
      if (!payload) throw new Error('Invalid JSON payload');
      const { upcoming, finished } = splitContests(payload.contests);
      const data = {
        contests: { upcoming, finished },
        generatedAt: payload.generatedAt
      };
      panel.webview.html = getWebviewContent(panel.webview, context, data);
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to load contest data: ${err.message}`);
      panel.webview.html = `<p>Error loading data.</p>`;
    }

    // 监听配置变化，自动刷新
    const configListener = vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('oiContestSchedule')) {
        // 简化：提示用户重新打开
        vscode.window.showInformationMessage('OI Contest Schedule configuration changed. Please reopen the view.');
      }
    });

    panel.onDidDispose(() => {
      configListener.dispose();
    });
  });

  context.subscriptions.push(disposable);
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};