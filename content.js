(function () {
  const PANEL_ID = "kb-workload-panel";
  const STORAGE_KEY = "kbWorkloadSettings";
  const TARGET_STATUSES = ["待测试", "已完成"];
  /** 活动/列表中的工单号：半角 # 或全角 ＃ */
  const ISSUE_REF_IN_TEXT = /(?:#|＃)\d{3,}/;
  const MAX_LIST_PAGES = 200;
  /** 工单详情并发拉取数（同域 HTTP/1.1 浏览器约 6 路，略高可吃满队列） */
  const DETAIL_FETCH_CONCURRENCY = 8;
  const SCAN_UI_THROTTLE_MS = 200;

  let activeScan = null;

  const STORAGE_USER_ID_KEY = "kbWorkloadUserId";

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "KB_WORKLOAD_OPEN_PANEL") {
      openPanel();
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "KB_WORKLOAD_PING") {
      const userId = detectCurrentUserId();
      if (userId) {
        chrome.storage.local.set({ [STORAGE_USER_ID_KEY]: userId });
      }
      sendResponse({ ok: true, userId: userId || "" });
      return false;
    }
    return false;
  });

  // 进入知识库页面时尝试缓存当前用户 ID，供跳转「我的活动」使用
  (() => {
    const userId = detectCurrentUserId();
    if (userId) {
      chrome.storage.local.set({ [STORAGE_USER_ID_KEY]: userId });
    }
  })();

  function openPanel() {
    const existing = document.getElementById(PANEL_ID);
    if (existing) {
      existing.remove();
    }

    const panel = document.createElement("section");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <header class="kb-workload-header">
        <div>
          <strong>FZ 工单工作量统计</strong>
        </div>
        <button type="button" data-action="close" aria-label="关闭">×</button>
      </header>
      <div class="kb-workload-body">
        <div class="kb-workload-months">
          <div class="kb-workload-months-head">
            <span class="kb-workload-months-title">月份</span>
            <div class="kb-workload-year-inline">
              <label class="kb-workload-year-sr" for="kb-workload-year-select">年份</label>
              <select id="kb-workload-year-select" data-field="year" class="kb-workload-year-select" title="选择年份" aria-label="选择年份"></select>
            </div>
            <div class="kb-workload-month-actions" role="group" aria-label="月份快捷">
              <button type="button" data-action="months-all" class="kb-workload-pill" title="本年份全选">全选</button>
              <button type="button" data-action="months-clear" class="kb-workload-pill" title="清空所選月份">清空</button>
            </div>
          </div>
          <div class="kb-workload-month-grid" data-role="month-grid" role="group" aria-label="选择统计月份，可多选"></div>
        </div>
        <div class="kb-workload-actions">
          <button type="button" data-action="scan" title="粗略统计：活动中改为「待测试」的工单数">提测工单数</button>
          <button type="button" data-action="detailed-scan" title="按已完成结算，统计可计入工作量的工单（含待测试→已完成）">完成工作量</button>
          <button type="button" data-action="stop" disabled>停止</button>
          <button type="button" data-action="export-html" disabled>导出 HTML 报表</button>
        </div>
        <div class="kb-workload-status" data-role="status">准备就绪</div>
        <div class="kb-workload-summary" data-role="summary"></div>
        <div class="kb-workload-month-chart kb-workload-month-chart--hidden" data-role="month-chart" aria-label="各月条数与环比"></div>
        <div class="kb-workload-results" data-role="results"></div>
      </div>
    `;

    document.body.appendChild(panel);
    initYearSelect(panel);
    initMonthGrid(panel);
    wirePanel(panel);
    loadSettings(panel)
      .then(() => {
        renderMonthChart(panel, getSelectedMonths(panel), getLastRows(panel) || []);
      })
      .catch((error) => {
        console.warn("[KB Workload] settings load failed", error);
        renderMonthChart(panel, getSelectedMonths(panel), getLastRows(panel) || []);
      });
  }

  function initYearSelect(panel) {
    const sel = panel.querySelector('[data-field="year"]');
    if (!sel) {
      return;
    }
    const y0 = new Date().getFullYear();
    sel.innerHTML = "";
    for (let y = y0 - 3; y <= y0 + 2; y++) {
      const opt = document.createElement("option");
      opt.value = String(y);
      opt.textContent = String(y);
      sel.appendChild(opt);
    }
    sel.value = String(y0);
    sel.addEventListener("change", () => {
      refreshMonthChart(panel);
    });
  }

  function initMonthGrid(panel) {
    const grid = panel.querySelector("[data-role='month-grid']");
    if (!grid) {
      return;
    }
    grid.innerHTML = "";
    for (let m = 1; m <= 12; m++) {
      const id = `kbw-m-${PANEL_ID}-${m}`;
      const label = document.createElement("label");
      label.className = "kb-workload-month-item";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.id = id;
      input.setAttribute("data-role", "month-cb");
      input.setAttribute("data-m", String(m));
      const span = document.createElement("span");
      span.className = "kb-workload-month-chip";
      span.textContent = `${m}月`;
      label.appendChild(input);
      label.appendChild(span);
      label.htmlFor = id;
      grid.appendChild(label);
    }
    grid.querySelectorAll("[data-role='month-cb']").forEach((input) => {
      input.addEventListener("change", () => {
        refreshMonthChart(panel);
      });
    });
  }

  function getSelectedMonths(panel) {
    const year = panel.querySelector('[data-field="year"]')?.value || String(new Date().getFullYear());
    return Array.from(panel.querySelectorAll("[data-role='month-cb']:checked"))
      .map((el) => `${year}-${String(el.getAttribute("data-m")).padStart(2, "0")}`)
      .filter(Boolean)
      .sort();
  }

  function refreshMonthChart(panel) {
    renderMonthChart(panel, getSelectedMonths(panel), getLastRows(panel) || []);
  }

  function wirePanel(panel) {
    panel.querySelector('[data-action="close"]').addEventListener("click", () => {
      panel.classList.add("kb-workload-hidden");
    });

    panel.querySelector('[data-action="scan"]').addEventListener("click", () => {
      startScan(panel);
    });

    panel.querySelector('[data-action="detailed-scan"]').addEventListener("click", () => {
      startDetailedScan(panel);
    });

    panel.querySelector('[data-action="stop"]').addEventListener("click", () => {
      if (activeScan) {
        activeScan.cancelled = true;
      }
    });

    const exportHtml = panel.querySelector('[data-action="export-html"]');
    if (exportHtml) {
      exportHtml.addEventListener("click", () => {
        const rows = getLastRows(panel);
        if (rows.length > 0) {
          downloadHtmlReport(
            getSelectedMonths(panel),
            rows,
            detectCurrentUserName(),
            "当前筛选的全部分页"
          );
        }
      });
    }

    const allM = panel.querySelector('[data-action="months-all"]');
    if (allM) {
      allM.addEventListener("click", () => {
        panel.querySelectorAll("[data-role='month-cb']").forEach((c) => {
          c.checked = true;
        });
        refreshMonthChart(panel);
      });
    }
    const clearM = panel.querySelector('[data-action="months-clear"]');
    if (clearM) {
      clearM.addEventListener("click", () => {
        panel.querySelectorAll("[data-role='month-cb']").forEach((c) => {
          c.checked = false;
        });
        refreshMonthChart(panel);
      });
    }
  }

  async function loadSettings(panel) {
    const defaultMonth = new Date().toISOString().slice(0, 7);
    const settings = await chrome.storage.local.get(STORAGE_KEY);
    const saved = settings[STORAGE_KEY] || {};
    const selYear = panel.querySelector('[data-field="year"]');
    if (saved.months && Array.isArray(saved.months) && saved.months.length) {
      const y = parseInt(String(saved.months[0]).slice(0, 4), 10);
      if (!Number.isNaN(y) && selYear) {
        selYear.value = String(y);
      }
    } else if (saved.year && selYear) {
      selYear.value = String(saved.year);
    }
    const yStr = selYear?.value || String(new Date().getFullYear());
    const monthSet = new Set(
      saved.months && saved.months.length > 0
        ? saved.months
        : saved.month
          ? [saved.month]
          : [defaultMonth]
    );
    panel.querySelectorAll("[data-role='month-cb']").forEach((cb) => {
      const m = String(cb.getAttribute("data-m")).padStart(2, "0");
      const v = `${yStr}-${m}`;
      cb.checked = monthSet.has(v);
    });
  }

  async function startScan(panel) {
    const months = getSelectedMonths(panel);
    const scope = "all";
    const username = detectCurrentUserName();
    const year = panel.querySelector('[data-field="year"]')?.value || String(new Date().getFullYear());

    if (months.length === 0) {
      setStatus(panel, "请至少勾选一个月份", true);
      return;
    }
    if (!username) {
      setStatus(panel, "未能识别当前用户，请确认已登录并刷新页面后重试。", true);
      return;
    }

    await chrome.storage.local.set({ [STORAGE_KEY]: { months, year } });

    const scan = { cancelled: false };
    activeScan = scan;
    setBusy(panel, true);
    setStatus(panel, "正在收集工单链接...");
    renderResults(panel, []);
    renderMonthChart(panel, months, []);
    const monthsSet = new Set(months);
    const monthLabel = `${formatMonthsLabel(months)}（提测工单数）`;

    try {
      if (isActivityPage(document)) {
        const activityResult = await collectActivityRows(scope, months, scan, (text) => setStatus(panel, text));
        if (scan.cancelled) {
          setStatus(panel, "已停止");
          return;
        }

        setLastRows(panel, activityResult.rows);
        renderResults(panel, activityResult.rows);
        renderMonthChart(panel, months, activityResult.rows);
        renderSummary(panel, {
          total: activityResult.rows.length,
          scanned: activityResult.scannedLinks,
          scannedLabel: "条工单活动",
          monthLabel,
          selectedMonths: months,
          username,
          rows: activityResult.rows
        });
        setStatus(
          panel,
          `提测工单数统计完成：命中 ${activityResult.rows.length} 条（按月份+工单去重），扫描 ${activityResult.scannedLinks} 条工单活动，来自 ${activityResult.scannedPages} 个页面。`
        );
        return;
      }

      const issueUrls = await collectIssueUrls(scope, months, scan, (text) => setStatus(panel, text));
      if (scan.cancelled) {
        setStatus(panel, "已停止");
        return;
      }

      const rows = [];
      const seenKeys = new Set();
      const progress = { completed: 0, total: issueUrls.length, failed: 0 };
      const ui = createThrottledUpdater(() => {
        setStatus(
          panel,
          `正在扫描历史记录 ${progress.completed}/${progress.total}（并发 ${DETAIL_FETCH_CONCURRENCY}），已命中 ${rows.length} 条，失败 ${progress.failed} 个。`
        );
      }, SCAN_UI_THROTTLE_MS);

      await processIssueDetails(issueUrls, scan, async (issueUrl, index) => {
        try {
          const detail = await fetchIssueDetail(issueUrl);
          const matches = extractMatchingChanges(detail.doc, {
            username,
            months,
            statuses: TARGET_STATUSES
          });

          if (matches.length === 0) {
            progress.completed += 1;
            ui.schedule();
            return;
          }

          const byMonth = new Map();
          for (const entry of matches) {
            const mk = entry.changedAt.slice(0, 7);
            if (!monthsSet.has(mk)) {
              continue;
            }
            if (!byMonth.has(mk)) {
              byMonth.set(mk, []);
            }
            byMonth.get(mk).push(entry);
          }

          for (const monthKey of months) {
            const list = byMonth.get(monthKey);
            if (!list || list.length === 0) {
              continue;
            }
            const dedupeK = `${detail.issueId}|${monthKey}`;
            if (seenKeys.has(dedupeK)) {
              continue;
            }
            seenKeys.add(dedupeK);
            const earliest = getEarliestMatch(list);
            rows.push({
              issueId: detail.issueId,
              monthKey,
              title: detail.title,
              url: issueUrl,
              tracker: detail.tracker || "",
              matchedStatuses: unique(list.map((item) => item.status)).join(" / "),
              firstChangedAt: earliest.changedAt,
              operator: earliest.operator,
              orderIndex: index
            });
          }
        } catch (error) {
          progress.failed += 1;
          console.warn("[KB Workload] issue scan failed", issueUrl, error);
        }

        progress.completed += 1;
        ui.schedule();
      });
      ui.flush();

      if (scan.cancelled) {
        setStatus(panel, "已停止");
        return;
      }

      const sortedRows = sortRows(rows);
      setLastRows(panel, sortedRows);
      renderResults(panel, sortedRows);
      renderMonthChart(panel, months, sortedRows);
      renderSummary(panel, {
        total: sortedRows.length,
        scanned: issueUrls.length,
        scannedLabel: "个工单详情",
        monthLabel,
        selectedMonths: months,
        username,
        rows: sortedRows
      });
      setStatus(
        panel,
        `提测工单数统计完成：命中 ${sortedRows.length} 条，扫描 ${issueUrls.length} 个工单详情，失败 ${progress.failed} 个。`
      );
    } catch (error) {
      console.error("[KB Workload] scan failed", error);
      setStatus(panel, `提测工单数统计失败：${error.message || error}`, true);
    } finally {
      setBusy(panel, false);
      activeScan = null;
    }
  }

  async function startDetailedScan(panel) {
    const months = getSelectedMonths(panel);
    const scope = "all";
    const username = detectCurrentUserName();
    const year = panel.querySelector('[data-field="year"]')?.value || String(new Date().getFullYear());

    if (months.length === 0) {
      setStatus(panel, "请至少勾选一个月份", true);
      return;
    }
    if (!username) {
      setStatus(panel, "未能识别当前用户，请确认已登录并刷新页面后重试。", true);
      return;
    }

    await chrome.storage.local.set({ [STORAGE_KEY]: { months, year } });

    const scan = { cancelled: false };
    activeScan = scan;
    setBusy(panel, true);
    setStatus(panel, "正在收集完成工作量候选工单...");
    renderResults(panel, []);
    renderMonthChart(panel, months, []);
    const monthLabel = `${formatMonthsLabel(months)}（完成工作量）`;

    try {
      const collected = await collectDetailedScanInput(scope, months, scan, username, (text) =>
        setStatus(panel, text)
      );
      const issueUrls = collected.issueUrls;
      if (issueUrls.length === 0 && collected.shortcutRows.length === 0) {
        setStatus(panel, "未收集到可访问的工单详情地址，请确认当前页包含 /issues/ 工单链接或 #工单号。", true);
        return;
      }
      if (scan.cancelled) {
        setStatus(panel, "已停止");
        return;
      }

      const rows = [];
      const seenKeys = new Set();
      for (const row of collected.shortcutRows) {
        const dedupeKey = `${row.issueId}|${normalizeUserName(row.operator)}|${row.monthKey}`;
        if (seenKeys.has(dedupeKey)) {
          continue;
        }
        seenKeys.add(dedupeKey);
        rows.push(row);
      }

      const progress = { completed: 0, total: issueUrls.length, failed: 0, withTimeline: 0 };
      const ui = createThrottledUpdater(() => {
        setDetailedProgress(panel, progress, rows.length);
      }, SCAN_UI_THROTTLE_MS);

      const shortcutHint =
        collected.skippedCompletedCount > 0
          ? `，已完成短路径跳过 ${collected.skippedCompletedCount} 个`
          : "";
      setStatus(
        panel,
        `开始并发查询 ${issueUrls.length} 个工单详情（并发 ${DETAIL_FETCH_CONCURRENCY}${shortcutHint}）...`
      );

      const skipIssueIds = collected.skipIssueIds || new Set();
      if (issueUrls.length > 0) {
        await processIssueDetails(issueUrls, scan, async (issueUrl, index) => {
          try {
            const issueIdFromUrl = extractIssueIdFromPath(new URL(issueUrl, location.href).pathname);
            if (issueIdFromUrl && skipIssueIds.has(issueIdFromUrl)) {
              progress.completed += 1;
              ui.schedule();
              return;
            }

            const detail = await fetchIssueDetail(issueUrl);
            const timeline = extractStatusTimeline(detail.doc);
            if (timeline.length > 0) {
              progress.withTimeline += 1;
            }

            // 详情里若勾选月已有「已完成」，后续同工单不再拉（并发队列兜底）
            if (
              detail.issueId &&
              timeline.some(
                (change) => change.status === "已完成" && isInSelectedMonths(change.changedAt, months)
              )
            ) {
              skipIssueIds.add(detail.issueId);
            }

            const settledRows = settleDetailedIssueRows(detail, issueUrl, months, username, index, timeline);

            for (const row of settledRows) {
              const dedupeKey = `${row.issueId}|${normalizeUserName(row.operator)}|${row.monthKey}`;
              if (seenKeys.has(dedupeKey)) {
                continue;
              }
              seenKeys.add(dedupeKey);
              rows.push(row);
            }
          } catch (_) {
            progress.failed += 1;
          }

          progress.completed += 1;
          ui.schedule();
        });
      }
      ui.flush();

      if (scan.cancelled) {
        setStatus(panel, "已停止");
        return;
      }

      const sortedRows = sortRows(rows);
      setLastRows(panel, sortedRows);
      renderResults(panel, sortedRows);
      renderMonthChart(panel, months, sortedRows);
      renderSummary(panel, {
        total: sortedRows.length,
        scanned: issueUrls.length,
        scannedLabel: "个工单详情",
        monthLabel,
        selectedMonths: months,
        username,
        rows: sortedRows
      });
      const shortcutText =
        collected.skippedCompletedCount > 0
          ? `，已完成短路径 ${collected.skippedCompletedCount} 个（未拉详情）`
          : "";
      setStatus(
        panel,
        `完成工作量统计完成：命中 ${sortedRows.length} 条，扫描 ${issueUrls.length} 个工单详情${shortcutText}，解析到状态历史 ${progress.withTimeline} 个，失败 ${progress.failed} 个。`
      );
    } catch (error) {
      console.error("[KB Workload] detailed scan failed", error);
      setStatus(panel, `完成工作量统计失败：${error.message || error}`, true);
    } finally {
      setBusy(panel, false);
      activeScan = null;
    }
  }

  function formatMonthsLabel(months) {
    if (!months.length) {
      return "";
    }
    return months
      .map((m) => (m.length >= 7 ? `${m.slice(0, 4)} 年 ${Number(m.slice(5, 7))} 月` : m))
      .join("、");
  }

  function earliestMonthFirstDay(months) {
    if (!months || months.length === 0) {
      return "";
    }
    return `${months.slice().sort()[0]}-01`;
  }

  /** 详细统计活动候选往前看：最早勾选月往前 1 个月的 1 号 */
  function activityLookbackStart(months) {
    if (!months || months.length === 0) {
      return "";
    }
    const earliest = months.slice().sort()[0];
    const year = Number(earliest.slice(0, 4));
    const month = Number(earliest.slice(5, 7));
    const total = year * 12 + (month - 1) - 1;
    const lookYear = Math.floor(total / 12);
    const lookMonth = (total % 12) + 1;
    return `${lookYear}-${String(lookMonth).padStart(2, "0")}-01`;
  }

  /**
   * 详细统计是否收录该条活动为候选工单：
   * 勾选月内仅收录含待测试/已完成的活动；勾选月之前 lookback 内仅收录「待测试」。
   */
  function shouldCollectDetailedActivityCandidate(dateStr, months, statuses) {
    if (!dateStr || !Array.isArray(statuses) || statuses.length === 0) {
      return false;
    }
    if (isInSelectedMonths(dateStr, months)) {
      return statuses.some((status) => TARGET_STATUSES.includes(status));
    }
    const lookbackStart = activityLookbackStart(months);
    const monthStart = earliestMonthFirstDay(months);
    if (!lookbackStart || !monthStart) {
      return false;
    }
    if (dateStr < lookbackStart || dateStr >= monthStart) {
      return false;
    }
    return statuses.includes("待测试");
  }

  function isInSelectedMonths(dateStr, months) {
    if (!dateStr || !months || months.length === 0) {
      return false;
    }
    return months.some((m) => dateStr.startsWith(m));
  }

  async function collectIssueUrls(scope, months, scan, onProgress) {
    const monthStart = earliestMonthFirstDay(months);
    const urls = [];
    const visitedPages = new Set();
    let pageUrl = new URL(location.href).href;

    while (pageUrl) {
      if (scan.cancelled) {
        break;
      }
      if (visitedPages.has(pageUrl)) {
        break;
      }
      visitedPages.add(pageUrl);
      onProgress(`正在读取列表页 ${visitedPages.size}: ${pageUrl}`);

      const doc = pageUrl === location.href ? document : await fetchDocument(pageUrl);
      const issueRows = collectIssueRows(doc, pageUrl);
      const candidateRows = issueRows.filter((row) => !row.updatedAt || row.updatedAt >= monthStart);
      candidateRows.forEach((row) => urls.push(row.url));

      if (scope !== "all") {
        break;
      }

      if (issueRows.length > 0 && issueRows.every((row) => row.updatedAt && row.updatedAt < monthStart)) {
        onProgress(`已到所选月份范围之前（早于 ${monthStart.slice(0, 7)}）的工单，停止继续翻页。`);
        break;
      }

      if (visitedPages.size >= MAX_LIST_PAGES) {
        onProgress(`已达到最多 ${MAX_LIST_PAGES} 个列表页的保护上限，停止继续翻页。`);
        break;
      }

      pageUrl = collectPaginationLink(doc, pageUrl, "next");
    }

    return unique(urls);
  }

  async function collectDetailedScanInput(scope, months, scan, username, onProgress) {
    const currentIssueUrl = getCurrentIssueUrl();

    if (isActivityPage(document)) {
      const collectedActivity = await collectDetailedActivityCandidates(months, scan, onProgress);
      const candidates = collectedActivity.candidates;
      const shortcut = buildCompletedActivityShortcutRows(candidates, months, username);
      const skipIssueIds = new Set([
        ...shortcut.skipIssueIds,
        ...collectedActivity.completedInSelectedMonths
      ]);
      const fetchUrls = unique(
        candidates
          .filter((item) => item.url && !skipIssueIds.has(item.issueId))
          .map((item) => item.url)
      );
      if (currentIssueUrl) {
        const currentId = extractIssueIdFromPath(new URL(currentIssueUrl).pathname);
        if (currentId && !skipIssueIds.has(currentId)) {
          fetchUrls.unshift(currentIssueUrl);
        }
      }
      return {
        issueUrls: fetchUrls.filter(isIssueDetailUrl),
        shortcutRows: shortcut.rows,
        skippedCompletedCount: skipIssueIds.size,
        skipIssueIds
      };
    }

    const collected = await collectIssueUrls(scope, months, scan, onProgress);
    const urls = unique([...(currentIssueUrl ? [currentIssueUrl] : []), ...collected].filter(isIssueDetailUrl));
    return {
      issueUrls: urls,
      shortcutRows: [],
      skippedCompletedCount: 0,
      skipIssueIds: new Set()
    };
  }

  function isIssueDetailUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      return parsed.origin === location.origin && Boolean(extractIssueIdFromPath(parsed.pathname));
    } catch (_) {
      return false;
    }
  }

  /**
   * 活动流里已显示「已完成」且落在勾选月：直接记当月，不再拉详情。
   * （本版不补算更早的待测试贡献人。）
   */
  function buildCompletedActivityShortcutRows(candidates, selectedMonths, username) {
    const rows = [];
    const skipIssueIds = new Set();
    const rowKeys = new Set();

    (candidates || []).forEach((item, index) => {
      if (!item?.issueId || !item.date) {
        return;
      }
      if (!Array.isArray(item.statuses) || !item.statuses.includes("已完成")) {
        return;
      }
      if (!isInSelectedMonths(item.date, selectedMonths)) {
        return;
      }

      skipIssueIds.add(item.issueId);

      const operator = item.operator || username;
      if (!sameUser(operator, username)) {
        return;
      }

      const monthKey = item.date.slice(0, 7);
      const rowKey = `${item.issueId}|${normalizeUserName(operator)}|${monthKey}`;
      if (rowKeys.has(rowKey)) {
        return;
      }
      rowKeys.add(rowKey);
      rows.push({
        issueId: item.issueId,
        monthKey,
        title: item.title || `#${item.issueId}`,
        url: item.url || `${location.origin}/issues/${item.issueId}`,
        tracker: item.tracker || "",
        matchedStatuses: "已完成",
        firstChangedAt: item.date,
        operator,
        settledBy: operator,
        settledAt: item.date,
        contributionChangedAt: item.date,
        orderIndex: item.orderIndex ?? index
      });
    });

    return { rows, skipIssueIds };
  }

  async function collectDetailedActivityCandidates(months, scan, onProgress) {
    const candidates = [];
    const completedInSelectedMonths = new Set();
    const visitedPages = new Set();
    // 结算按「已完成」当月归属，但待测试可能发生在更早月份；需往前翻页收集待测试候选。
    const lookbackStart = activityLookbackStart(months);
    const monthLabel = formatMonthsLabel(months);
    let pageUrl = new URL(location.href).href;
    let orderIndex = 0;

    while (pageUrl) {
      if (scan.cancelled || visitedPages.has(pageUrl)) {
        break;
      }

      visitedPages.add(pageUrl);
      onProgress(`正在翻活动页收集${monthLabel}候选工单 ${visitedPages.size}: ${pageUrl}`);

      const doc = pageUrl === location.href ? document : await fetchDocument(pageUrl);
      const root = findActivityStreamRoot(doc);
      const pageOperator = detectCurrentUserName(doc);
      collectActivityEntryNodes(root).forEach((node) => {
        const rawText = normalizeWhitespace(text(node));
        const date = findActivityDate(node);
        const issueLink = node.matches?.("a[href]") ? node : node.querySelector('a[href*="/issues/"]');
        const url = normalizeIssueUrl(issueLink?.getAttribute("href"), pageUrl, rawText) || "";
        const issueId =
          getIssueIdFromEntryNode(node, pageUrl, rawText) ||
          (url ? extractIssueIdFromPath(new URL(url, pageUrl).pathname) : "");
        if (!issueId) {
          return;
        }

        // 当月已出现过「已完成」：历史中再出现同一工单直接跳过，不再作为候选/拉详情
        if (completedInSelectedMonths.has(issueId)) {
          return;
        }

        const statuses = extractStatusesFromText(rawText);
        if (!shouldCollectDetailedActivityCandidate(date, months, statuses)) {
          return;
        }

        if (
          Array.isArray(statuses) &&
          statuses.includes("已完成") &&
          isInSelectedMonths(date, months)
        ) {
          completedInSelectedMonths.add(issueId);
        }

        const resolvedUrl = url || `${location.origin}/issues/${issueId}`;
        candidates.push({
          issueId,
          url: resolvedUrl,
          date,
          statuses,
          title: buildActivityTitle(rawText, issueId) || `#${issueId}`,
          tracker: extractTrackerFromActivityText(rawText, issueId),
          operator: pageOperator,
          orderIndex: orderIndex++
        });
      });

      const pageDates = extractActivityPageDates(doc);
      if (pageDates.length > 0 && lookbackStart && pageDates.every((date) => date < lookbackStart)) {
        onProgress(`活动页记录已早于回看起点 ${lookbackStart.slice(0, 7)}，停止继续翻页。`);
        break;
      }

      if (visitedPages.size >= MAX_LIST_PAGES) {
        onProgress(`已达到最多 ${MAX_LIST_PAGES} 个活动页的保护上限，停止继续翻页。`);
        break;
      }

      pageUrl = collectPaginationLink(doc, pageUrl, "prev");
    }

    return { candidates, completedInSelectedMonths };
  }

  function getCurrentIssueUrl() {
    const issueId = extractIssueIdFromPath(location.pathname);
    return issueId ? `${location.origin}/issues/${issueId}` : "";
  }

  function collectIssueRows(doc, baseUrl) {
    const rows = Array.from(doc.querySelectorAll("tr.issue"));
    if (rows.length === 0) {
      return collectIssueLinks(doc, baseUrl).map((url) => ({ url, updatedAt: "" }));
    }

    return rows
      .map((row) => {
        const link = row.querySelector('a[href*="/issues/"]');
        const url = normalizeIssueUrl(link?.getAttribute("href"), baseUrl);
        if (!url) {
          return null;
        }
        return {
          url,
          updatedAt: parseIssueRowUpdatedAt(row)
        };
      })
      .filter(Boolean);
  }

  function parseIssueRowUpdatedAt(row) {
    const candidates = [
      row.querySelector("td.updated_on"),
      row.querySelector("td.updated"),
      row.querySelector("td.last_updated"),
      row.querySelector("td:last-child")
    ].filter(Boolean);

    for (const candidate of candidates) {
      const value = parseDate(candidate);
      if (value) {
        return value;
      }
    }
    return "";
  }

  function collectIssueLinks(doc, baseUrl) {
    return collectIssueCandidates(doc, baseUrl).map((candidate) => candidate.url);
  }

  function isDisabledPaginationLink(a) {
    if (!a) {
      return true;
    }
    const h = a.getAttribute("href");
    if (!h || h === "#" || /^javascript:/i.test(h)) {
      return true;
    }
    if (a.getAttribute("aria-disabled") === "true") {
      return true;
    }
    if (a.classList.contains("disabled") || a.matches?.("a[disabled]")) {
      return true;
    }
    if (
      a.closest(
        "span.disabled, .disabled, li.disabled, " +
          ".pagination .next.disabled, .page.next.disabled, " +
          ".pagination .prev.disabled, .page.prev.disabled, " +
          "span.next.disabled, span.prev.disabled, " +
          "li.next.disabled, li.prev.disabled, " +
          ".page.previous.disabled, .previous_page.disabled, li.previous.disabled"
      )
    ) {
      return true;
    }
    return false;
  }

  function resolveNextPageUrl(a, baseUrl) {
    if (isDisabledPaginationLink(a)) {
      return "";
    }
    let origin;
    try {
      origin = new URL(baseUrl).origin;
    } catch {
      origin = location.origin;
    }
    try {
      const href = a.getAttribute("href");
      const url = new URL(href, baseUrl);
      return url.origin === origin ? url.href : "";
    } catch {
      return "";
    }
  }

  /**
   * 工单列表用 follow="next"：点「下一页」/ rel=next。
   * 活动流用 follow="prev"：kb 活动页是新的在前，继续扫更早活动要点「上一页」/ rel=prev（否则 下一页 可能是更新一页）。
   */
  function collectPaginationLink(doc, baseUrl, follow) {
    const wantPrev = follow === "prev";
    const candidates = unique(
      Array.from(
        doc.querySelectorAll(
          [
            "a[rel='next']",
            "a[rel='prev']",
            "a[rel='previous']",
            ".pagination a",
            "p.pagination a",
            "nav.pagination a",
            "#content .pagination a",
            ".pages a",
            "[class*='paginat'] a",
            "a[href*='page=']",
            "a[href*='p=']",
            "a[href*='offset=']"
          ].join(",")
        )
      )
    );

    if (wantPrev) {
      const rel = doc.querySelector(
        "#content a[rel='prev'], #content a[rel='previous'], " +
          ".pagination a[rel='prev'], .pagination a[rel='previous'], p.pagination a[rel='prev']"
      );
      if (rel) {
        const u = resolveNextPageUrl(rel, baseUrl);
        if (u) {
          return u;
        }
      }

      const inPrevSlot = candidates.find(
        (a) =>
          !isDisabledPaginationLink(a) &&
          (a.closest("span.prev, li.prev, .page.prev, .prev_page, .previous_page, li[class*='prev']") ||
            a.id === "prev" ||
            a.id === "previous" ||
            a.classList.contains("prev") ||
            a.classList.contains("previous"))
      );
      if (inPrevSlot) {
        const u = resolveNextPageUrl(inPrevSlot, baseUrl);
        if (u) {
          return u;
        }
      }

      const byPrevLabel = candidates.find((link) => {
        if (isDisabledPaginationLink(link)) {
          return false;
        }
        if (link.getAttribute("rel") === "next") {
          return false;
        }
        const t = text(link);
        const meta = `${link.getAttribute("title") || ""} ${link.getAttribute("aria-label") || ""}`.toLowerCase();
        const combined = `${t} ${meta}`;
        if (link.getAttribute("rel") === "prev" || link.getAttribute("rel") === "previous") {
          return true;
        }
        if (/\bnext\b|下一(页|頁)|^下[一]?(页|頁)$|后(一)?(页|頁)/i.test(combined) && !/上[一]?(页|頁)/i.test(t)) {
          return false;
        }
        if (/\bprevious\b(?!-)/i.test(combined) && !/\bnext\b|下一|›\s*$/i.test(combined)) {
          return true;
        }
        if (/^上[一]?(页|頁)$|^上页$|^\s*‹\s*$|^\s*«\s*$/i.test(t.trim()) || /上一(页|頁)/.test(t)) {
          return true;
        }
        if (/[‹«]\s*$/.test(t) && t.length <= 3) {
          return true;
        }
        return false;
      });
      if (byPrevLabel) {
        return resolveNextPageUrl(byPrevLabel, baseUrl) || "";
      }
      return "";
    }

    const inNextSlot = candidates.find(
      (a) =>
        !isDisabledPaginationLink(a) &&
        (a.closest("span.next, li.next, .page.next, .next_page, li[class*='next']") ||
          a.id === "next" ||
          a.classList.contains("next"))
    );
    if (inNextSlot) {
      const u = resolveNextPageUrl(inNextSlot, baseUrl);
      if (u) {
        return u;
      }
    }

    const rel = doc.querySelector(
      "#content a[rel='next'], .pagination a[rel='next'], p.pagination a[rel='next'], a[rel='next']"
    );
    if (rel) {
      const u = resolveNextPageUrl(rel, baseUrl);
      if (u) {
        return u;
      }
    }

    const byLabel = candidates.find((link) => {
      if (isDisabledPaginationLink(link)) {
        return false;
      }
      const t = text(link);
      const meta = `${link.getAttribute("title") || ""} ${link.getAttribute("aria-label") || ""}`.toLowerCase();
      const combined = `${t} ${meta}`;
      if (link.getAttribute("rel") === "next") {
        return true;
      }
      if ((/上[一]?页|previous|前[一]?页|first( page)?/i.test(combined) && !/下一(页|next)/i.test(combined)) || link.getAttribute("rel") === "prev") {
        return false;
      }
      if (/\bnext\b/i.test(combined) && !/previous|上一|前[一]页|first/i.test(combined)) {
        return true;
      }
      if (/下一(页|頁)|^下(一)?(页|頁)$|^后(一)?(页|頁)$|^\s*›\s*$|^\s*»\s*$/i.test(t)) {
        return true;
      }
      if (/[›>→]\s*$/.test(t) && t.length <= 3) {
        return true;
      }
      return false;
    });
    if (byLabel) {
      const u = resolveNextPageUrl(byLabel, baseUrl);
      if (u) {
        return u;
      }
    }
    return "";
  }

  function normalizeIssueUrl(href, baseUrl, fallbackText = "") {
    if (!href) {
      return null;
    }
    try {
      const url = new URL(href, baseUrl);
      if (url.origin !== location.origin) {
        return null;
      }

      const issueId =
        extractIssueIdFromPath(url.pathname) ||
        extractIssueIdFromSearch(url) ||
        extractIssueIdFromText(fallbackText);

      if (!issueId) {
        return null;
      }

      return `${url.origin}/issues/${issueId}`;
    } catch (_) {
      return null;
    }
  }

  function collectIssueCandidates(root, baseUrl) {
    const seen = new Set();
    const candidates = [];

    Array.from(root.querySelectorAll("a[href]")).forEach((link) => {
      const label = [
        text(link),
        link.getAttribute("title"),
        link.getAttribute("aria-label")
      ].filter(Boolean).join(" ");
      const url = normalizeIssueUrl(link.getAttribute("href"), baseUrl, label);
      if (!url || seen.has(url)) {
        return;
      }
      seen.add(url);
      candidates.push({ url, link });
    });

    return candidates;
  }

  function extractIssueIdFromPath(pathname) {
    const patterns = [
      /\/issues\/(\d+)(?:\/|$)/,
      /\/issues\/show\/(\d+)(?:\/|$)/,
      /\/issue\/(\d+)(?:\/|$)/,
      /\/bugs?\/(\d+)(?:\/|$)/,
      /\/tickets?\/(\d+)(?:\/|$)/
    ];

    for (const pattern of patterns) {
      const match = pathname.match(pattern);
      if (match?.[1]) {
        return match[1];
      }
    }
    return "";
  }

  function extractIssueIdFromSearch(url) {
    const candidates = ["issue_id", "id", "issueId", "ticket_id", "ticketId"];
    for (const key of candidates) {
      const value = url.searchParams.get(key);
      if (/^\d+$/.test(value || "")) {
        return value;
      }
    }
    return "";
  }

  function extractIssueIdFromText(rawText) {
    const match = normalizeWhitespace(rawText).match(/(?:#|＃)(\d{3,})/);
    return match?.[1] || "";
  }

  /** 活动行：优先从文案 #123 取 ID，否则从 /issues/… 链接（部分主题或链接文案无 #，且需排除指向用户的 a） */
  function getIssueIdFromEntryNode(node, baseUrl, rawText) {
    const t = rawText !== undefined ? rawText : normalizeWhitespace(text(node));
    const fromText = extractIssueIdFromText(t);
    if (fromText) {
      return fromText;
    }

    const candidates = [];
    if (node?.matches?.('a[href*="/issues/"]') || (node?.matches?.("a[href]") && (node.getAttribute("href") || "").includes("/issues/"))) {
      candidates.push(node);
    }
    if (node?.querySelectorAll) {
      candidates.push(...Array.from(node.querySelectorAll('a[href*="/issues/"]')));
    }

    for (const el of candidates) {
      const href = el.getAttribute("href");
      if (!href) {
        continue;
      }
      try {
        const path = new URL(href, baseUrl).pathname;
        const id = extractIssueIdFromPath(path);
        if (id) {
          return id;
        }
      } catch (_) {
        /* ignore */
      }
    }
    return "";
  }

  async function fetchIssueDetail(url) {
    const doc = await fetchDocument(url);
    const path = new URL(url).pathname;
    const idFromPath = path.match(/\/issues\/(\d+)(?:\/|$)/i);
    const issueId = idFromPath?.[1] || path.split("/").filter(Boolean).pop() || "";
    const title =
      text(doc.querySelector("h2")) ||
      text(doc.querySelector(".subject h3")) ||
      `#${issueId}`;

    return { doc, issueId, title, tracker: extractTrackerFromIssueDoc(doc) };
  }

  async function processIssueDetails(issueUrls, scan, onIssue) {
    let cursor = 0;
    const workerCount = Math.min(DETAIL_FETCH_CONCURRENCY, issueUrls.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (!scan.cancelled) {
        const index = cursor;
        cursor += 1;
        if (index >= issueUrls.length) {
          return;
        }
        await onIssue(issueUrls[index], index);
      }
    });
    await Promise.all(workers);
  }

  function createThrottledUpdater(fn, intervalMs) {
    let timer = null;
    let dirty = false;
    let lastRunAt = 0;

    function run() {
      dirty = false;
      lastRunAt = Date.now();
      fn();
    }

    return {
      schedule() {
        dirty = true;
        const elapsed = Date.now() - lastRunAt;
        if (elapsed >= intervalMs) {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          run();
          return;
        }
        if (timer) {
          return;
        }
        timer = setTimeout(() => {
          timer = null;
          if (dirty) {
            run();
          }
        }, Math.max(0, intervalMs - elapsed));
      },
      flush() {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (dirty) {
          run();
        }
      }
    };
  }

  function isActivityPage(doc) {
    return Boolean(
      location.pathname.includes("/activity") ||
      detectActivityOwnerName(doc) ||
      doc.querySelector("#activity, .activity")
    );
  }

  async function collectActivityRows(scope, months, scan, onProgress) {
    const monthStart = earliestMonthFirstDay(months);
    const rowsByKey = new Map();
    const visitedPages = new Set();
    let pageUrl = new URL(location.href).href;
    let scannedLinks = 0;

    while (pageUrl) {
      if (scan.cancelled || visitedPages.has(pageUrl)) {
        break;
      }

      visitedPages.add(pageUrl);
      onProgress(`正在读取活动页 ${visitedPages.size}: ${pageUrl}`);

      const doc = pageUrl === location.href ? document : await fetchDocument(pageUrl);
      const pageResult = extractActivityMatches(doc, pageUrl, months);
      const pageRows = pageResult.rows;
      scannedLinks += pageResult.scannedLinks;

      for (const row of pageRows) {
        const mk = row.monthKey || (row.firstChangedAt && row.firstChangedAt.slice(0, 7));
        const key = `${row.issueId}|${mk}`;
        const existing = rowsByKey.get(key);
        if (!existing) {
          rowsByKey.set(key, row);
          continue;
        }

        if (!existing.tracker && row.tracker) {
          existing.tracker = row.tracker;
        }
        existing.firstChangedAt = [existing.firstChangedAt, row.firstChangedAt].filter(Boolean).sort()[0] || "";
        existing.matchedStatuses = unique(
          `${existing.matchedStatuses} / ${row.matchedStatuses}`.split(/\s*\/\s*/)
        ).join(" / ");
        existing.orderIndex = Math.min(existing.orderIndex, row.orderIndex);
      }

      if (scope !== "all") {
        break;
      }

      const pageDates = extractActivityPageDates(doc);
      if (pageDates.length > 0 && monthStart && pageDates.every((date) => date < monthStart)) {
        onProgress(`活动页记录已早于 ${monthStart.slice(0, 7)}，停止继续翻页。`);
        break;
      }

      if (visitedPages.size >= MAX_LIST_PAGES) {
        onProgress(`已达到最多 ${MAX_LIST_PAGES} 个活动页的保护上限，停止继续翻页。`);
        break;
      }

      pageUrl = collectPaginationLink(doc, pageUrl, "prev");
    }

    return {
      rows: sortRows(Array.from(rowsByKey.values())),
      scannedLinks,
      scannedPages: visitedPages.size
    };
  }

  async function fetchDocument(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let response;
    try {
      response = await fetch(url, {
        credentials: "include",
        cache: "no-store",
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new Error(`请求失败 ${response.status}: ${url}`);
    }
    const html = await response.text();
    return new DOMParser().parseFromString(html, "text/html");
  }

  function extractMatchingChanges(doc, options) {
    const journals = uniqueNodes(
      doc.querySelectorAll("#history .journal, .journal, div[id^='change-']")
    );

    return journals
      .map((journal) => parseJournal(journal))
      .filter((entry) => {
        if (!entry.operator || !entry.changedAt) {
          return false;
        }
        if (!sameUser(entry.operator, options.username)) {
          return false;
        }
        if (!isInSelectedMonths(entry.changedAt, options.months)) {
          return false;
        }
        return entry.statuses.some((status) => options.statuses.includes(status));
      })
      .map((entry) => ({
        ...entry,
        status: unique(entry.statuses.filter((status) => options.statuses.includes(status))).join(" / ")
      }));
  }

  function extractStatusTimeline(doc) {
    const journals = uniqueNodes(
      doc.querySelectorAll("#history .journal, .journal, div[id^='change-']")
    );

    return journals
      .flatMap((journal, orderIndex) => {
        const entry = parseJournal(journal);
        if (!entry.operator || !entry.changedAt) {
          return [];
        }
        const targetStatuses = extractTargetStatusesFromJournal(journal, entry.rawText);
        return targetStatuses.map((status) => ({
          operator: entry.operator,
          changedAt: entry.changedAt,
          status,
          sequence: extractJournalSequence(journal, orderIndex),
          orderIndex
        }));
      })
      .sort((left, right) => {
        if (left.changedAt !== right.changedAt) {
          return left.changedAt.localeCompare(right.changedAt);
        }
        if (left.sequence !== right.sequence) {
          return left.sequence - right.sequence;
        }
        return left.orderIndex - right.orderIndex;
      });
  }

  function extractJournalSequence(journal, fallback) {
    const raw = journal?.id || "";
    const match = raw.match(/\d+/);
    return match ? Number(match[0]) : fallback;
  }

  function extractTargetStatusesFromJournal(journal, fallbackText) {
    const detailNodes = uniqueNodes(
      journal.querySelectorAll("ul.details li, .details li, table.details tr, .journal-details li")
    );
    const structuredMatches = unique(
      detailNodes.flatMap((node) => extractTargetStatusesFromDetailNode(node))
    );
    if (structuredMatches.length > 0) {
      return structuredMatches;
    }
    return extractTargetStatusesFromText(fallbackText);
  }

  function extractTargetStatusesFromDetailNode(node) {
    const raw = normalizeWhitespace(text(node));
    if (!raw || !/(状态|status)/i.test(raw)) {
      return [];
    }

    const emphasizedTexts = Array.from(node.querySelectorAll("i, em, strong, span"))
      .map((child) => normalizeWhitespace(text(child)))
      .filter(Boolean);
    if (emphasizedTexts.length > 0) {
      const last = emphasizedTexts[emphasizedTexts.length - 1];
      if (TARGET_STATUSES.includes(last)) {
        return [last];
      }
      if (emphasizedTexts.length >= 2) {
        return [];
      }
    }

    return extractTargetStatusesFromText(raw);
  }

  function extractTargetStatusesFromText(rawText) {
    if (!rawText) {
      return [];
    }
    return TARGET_STATUSES.filter((status) => {
      return new RegExp(
        `(?:状态|status)[^\\n]{0,40}(?:改为|变更为|changed to|to|=>|->|→)[^\\n]{0,20}${escapeRegExp(status)}`,
        "i"
      ).test(rawText) || new RegExp(
        `(?:改为|变更为|changed to|to|=>|->|→)\\s*["“']?${escapeRegExp(status)}["”']?(?=[^\\n]{0,20}(?:状态|status)|$)`,
        "i"
      ).test(rawText);
    });
  }

  function settleDetailedIssueRows(detail, issueUrl, selectedMonths, username, orderIndex, timelineInput) {
    const monthSet = new Set(selectedMonths || []);
    const rows = [];
    const timeline = timelineInput || extractStatusTimeline(detail.doc);
    const completions = timeline.filter((change) => change.status === "已完成");
    const rowKeys = new Set();
    let cycleStart = "";

    for (const completion of completions) {
      const monthKey = completion.changedAt.slice(0, 7);
      const contributors = new Map();

      timeline.forEach((change) => {
        if (change.status !== "待测试") {
          return;
        }
        if (cycleStart && change.changedAt < cycleStart) {
          return;
        }
        if (change.changedAt > completion.changedAt) {
          return;
        }
        contributors.set(normalizeUserName(change.operator), {
          operator: change.operator,
          changedAt: change.changedAt
        });
      });
      contributors.set(normalizeUserName(completion.operator), {
        operator: completion.operator,
        changedAt: completion.changedAt,
        completedBySelf: true
      });

      if (monthSet.has(monthKey)) {
        for (const contributor of contributors.values()) {
          if (!sameUser(contributor.operator, username)) {
            continue;
          }
          const rowKey = `${detail.issueId}|${normalizeUserName(contributor.operator)}|${monthKey}`;
          if (rowKeys.has(rowKey)) {
            continue;
          }
          rowKeys.add(rowKey);
          rows.push({
            issueId: detail.issueId,
            monthKey,
            title: detail.title,
            url: issueUrl,
            tracker: detail.tracker || "",
            matchedStatuses: contributor.completedBySelf ? "已完成" : "待测试 → 已完成",
            firstChangedAt: completion.changedAt,
            operator: contributor.operator,
            settledBy: completion.operator,
            settledAt: completion.changedAt,
            contributionChangedAt: contributor.changedAt,
            orderIndex
          });
        }
      }

      // 详情页通常只有日期没有时间；同一天内的待测试/已完成按同一轮处理。
      cycleStart = completion.changedAt;
    }

    return rows;
  }

  function getEarliestMatch(matches) {
    return matches.reduce((earliest, current) => {
      if (!earliest.changedAt) {
        return current;
      }
      if (current.changedAt && current.changedAt < earliest.changedAt) {
        return current;
      }
      return earliest;
    });
  }

  function parseJournal(journal) {
    const heading = journal.querySelector("h4, .journal-details, .note-header") || journal;
    const detailsText = normalizeWhitespace(text(journal));
    const operator = parseOperator(heading);
    const changedAt = parseDate(heading) || parseDate(journal);
    const statuses = extractStatusesFromJournal(journal, detailsText);

    return {
      operator,
      changedAt,
      statuses,
      rawText: detailsText
    };
  }

  function extractStatusesFromJournal(journal, fallbackText) {
    const detailNodes = uniqueNodes(
      journal.querySelectorAll("ul.details li, .details li, table.details tr, .journal-details li")
    );
    const structuredMatches = unique(
      detailNodes.flatMap((node) => extractStatusesFromDetailNode(node))
    );
    if (structuredMatches.length > 0) {
      return structuredMatches;
    }
    return extractStatusesFromText(fallbackText);
  }

  function extractStatusesFromDetailNode(node) {
    const raw = normalizeWhitespace(text(node));
    if (!raw || !/(状态|status)/i.test(raw)) {
      return [];
    }

    const emphasizedTexts = Array.from(node.querySelectorAll("i, em, strong, span"))
      .map((child) => normalizeWhitespace(text(child)))
      .filter(Boolean);

    return TARGET_STATUSES.filter((status) => {
      if (emphasizedTexts.includes(status)) {
        return true;
      }
      return new RegExp(
        `(?:状态|status)[^\\n]{0,30}(?:改为|变更为|changed to|to|=>|->|→)?[^\\n]{0,12}${escapeRegExp(status)}`,
        "i"
      ).test(raw);
    });
  }

  function extractStatusesFromText(rawText) {
    if (!rawText) {
      return [];
    }
    return TARGET_STATUSES.filter((status) => {
      if (status === "待测试" && (/\bto\s*be\s*tested\b/i.test(rawText) || /\bfor\s*testing\b/i.test(rawText))) {
        return true;
      }
      if (status === "已完成" && /\bcompleted\b/i.test(rawText) && !/\b(incomplete|uncompleted)\b/i.test(rawText)) {
        return true;
      }
      return new RegExp(
        `(?:状态|status)[^\\n]{0,30}(?:改为|变更为|changed to|to|=>|->|→)?[^\\n]{0,12}${escapeRegExp(status)}`,
        "i"
      ).test(rawText) || new RegExp(
        `(?:改为|变更为|changed to|to)\\s*["“']?${escapeRegExp(status)}["”']?(?=[^\\n]{0,20}(?:状态|status)|$)`,
        "i"
      ).test(rawText) || new RegExp(
        `[（(]\\s*${escapeRegExp(status)}\\s*([/／]|[)）])`,
        "i"
      ).test(rawText);
    });
  }

  function extractActivityMatches(doc, baseUrl, months) {
    const root = findActivityStreamRoot(doc);
    const entryNodes = collectActivityEntryNodes(root);
    const rows = [];
    const seen = new Set();

    entryNodes.forEach((node, index) => {
      const rawText = normalizeWhitespace(text(node));
      const issueLink = node.matches?.("a[href]") ? node : node.querySelector('a[href*="/issues/"]');
      const url = normalizeIssueUrl(issueLink?.getAttribute("href"), baseUrl, rawText) || "";
      const issueId = getIssueIdFromEntryNode(node, baseUrl, rawText) || extractIssueIdFromPath(new URL(url || baseUrl).pathname);
      const date = findActivityDate(node);
      const statuses = extractStatusesFromText(rawText);
      const title = buildActivityTitle(rawText, issueId);
      const tracker = extractTrackerFromActivityText(rawText, issueId);
      const monthKey = date && date.length >= 7 ? date.slice(0, 7) : "";

      if (!issueId || !date || !isInSelectedMonths(date, months) || statuses.length === 0) {
        return;
      }

      const dedupeKey = `${issueId}|${date}|${statuses.join("/")}`;
      if (seen.has(dedupeKey)) {
        return;
      }
      seen.add(dedupeKey);

      rows.push({
        issueId,
        monthKey,
        title: title || `#${issueId}`,
        url: url || `${location.origin}/issues/${issueId}`,
        tracker,
        matchedStatuses: unique(statuses).join(" / "),
        firstChangedAt: date,
        operator: detectCurrentUserName(doc),
        orderIndex: index
      });
    });

    if (rows.length === 0) {
      const textRows = extractActivityMatchesFromText(root, months, detectCurrentUserName(doc), baseUrl);
      return {
        rows: textRows,
        scannedLinks: Math.max(entryNodes.length, textRows.length)
      };
    }

    return {
      rows,
      scannedLinks: entryNodes.length
    };
  }

  function extractActivityMatchesFromText(root, months, operator, baseUrl) {
    const candidates = uniqueNodes(
      root.querySelectorAll("dt, dd, li, article, p, div, tr, [class*='event']")
    );
    const rows = [];
    const seen = new Set();

    candidates.forEach((node, index) => {
      const rawText = normalizeWhitespace(text(node));
      const issueId = getIssueIdFromEntryNode(node, baseUrl, rawText);
      const statuses = extractStatusesFromText(rawText);
      const date = findActivityDate(node);
      const tracker = extractTrackerFromActivityText(rawText, issueId);
      const monthKey = date && date.length >= 7 ? date.slice(0, 7) : "";

      if (!issueId || !date || !isInSelectedMonths(date, months) || statuses.length === 0) {
        return;
      }

      const dedupeKey = `${issueId}|${date}|${statuses.join("/")}`;
      if (seen.has(dedupeKey)) {
        return;
      }
      seen.add(dedupeKey);

      rows.push({
        issueId,
        monthKey,
        title: buildActivityTitle(rawText, issueId) || `#${issueId}`,
        url: `${location.origin}/issues/${issueId}`,
        tracker,
        matchedStatuses: unique(statuses).join(" / "),
        firstChangedAt: date,
        operator,
        orderIndex: index
      });
    });

    return rows;
  }

  function extractActivityPageDates(doc) {
    const root = findActivityStreamRoot(doc);
    return unique(
      Array.from(
        root.querySelectorAll("h1, h2, h3, h4, h5, h6, .date, .journal-date, time[datetime]")
      )
        .map((node) => {
          if (node.matches?.("time[datetime]")) {
            return (node.getAttribute("datetime") || "").slice(0, 10);
          }
          return parseDate(node);
        })
        .filter(Boolean)
    ).sort();
  }

  function findActivityStreamRoot(doc) {
    const directRoot = doc.querySelector("#activity, .activity");
    if (directRoot && hasActivityStreamContent(directRoot)) {
      return directRoot;
    }

    const ownerHeading = Array.from(doc.querySelectorAll("h1, h2, h3, h4"))
      .find((node) => /的活动$/.test(text(node)));

    if (ownerHeading) {
      const siblingRoot = findActivityRootFromHeading(ownerHeading);
      if (siblingRoot) {
        return siblingRoot;
      }

      let current = ownerHeading.parentElement;
      while (current && current !== doc.body) {
        if (hasActivityContent(current)) {
          return current;
        }
        current = current.parentElement;
      }
      return ownerHeading.parentElement || doc.body;
    }

    const candidates = [
      doc.querySelector("#content"),
      doc.querySelector("div#content"),
      doc.querySelector("main"),
      doc.body
    ].filter(Boolean);

    return candidates.find((node) => hasActivityContent(node)) || candidates[0] || doc.body;
  }

  /** 避免未渲染或占位的 #activity 空壳；真正活动区一般含 /issues/ 链接或工单号 */
  function hasActivityStreamContent(node) {
    if (!node) {
      return false;
    }
    if (node.querySelector('a[href*="/issues/"]')) {
      return true;
    }
    const raw = normalizeWhitespace(text(node));
    if (ISSUE_REF_IN_TEXT.test(raw)) {
      return true;
    }
    return /\/issues\/\d{3,}/i.test(node.innerHTML || "");
  }

  function hasActivityContent(node) {
    const raw = normalizeWhitespace(text(node));
    const hasDate = /\d{4}-\d{2}-\d{2}/.test(raw) || /\d{4}年\d{1,2}月\d{1,2}日/.test(raw);
    const hasIssue = ISSUE_REF_IN_TEXT.test(raw) || /\/issues\/\d{3,}/i.test(node.innerHTML || "");
    return hasIssue && hasDate;
  }

  function findActivityRootFromHeading(ownerHeading) {
    let sibling = ownerHeading.nextElementSibling;
    while (sibling) {
      if (hasActivityContent(sibling)) {
        return sibling;
      }
      sibling = sibling.nextElementSibling;
    }
    return null;
  }

  function collectActivityEntryNodesFromIssueLinks(root) {
    const links = root.querySelectorAll('a[href*="/issues/"]');
    const rows = new Set();
    const base = location.href;
    links.forEach((a) => {
      if (a.closest("#top-menu, #header, #account, .flyout, #login-form, #sidebar, .sidebar, aside.sidebar")) {
        return;
      }
      const href = a.getAttribute("href");
      if (!href) {
        return;
      }
      let id = "";
      try {
        id = extractIssueIdFromPath(new URL(href, base).pathname);
      } catch (_) {
        return;
      }
      if (!id) {
        return;
      }
      const row =
        a.closest(
          "dd, li, tr, article, p, [class*='event'], [class*='activity'], .issue, .journal"
        ) || a.parentElement;
      if (row) {
        rows.add(row);
      }
    });
    return Array.from(rows);
  }

  function collectActivityEntryNodes(root) {
    // Redmine 活动流常用 <dl><dt>时间</dt><dd>内容</dd>；工单号可能只在 /issues/ 链接上
    const selectors = [
      "dl > dd",
      "dd",
      "dl > dt",
      "dt",
      ".activity-item",
      ".journal",
      "li"
    ];
    const fromSelectors = uniqueNodes(
      selectors.flatMap((selector) => Array.from(root.querySelectorAll(selector)))
    );
    const fromLinks = collectActivityEntryNodesFromIssueLinks(root);
    const nodes = uniqueNodes([...fromSelectors, ...fromLinks]);

    return nodes.filter((node) => {
      const rawText = normalizeWhitespace(text(node));
      if (!rawText) {
        return false;
      }
      if (ISSUE_REF_IN_TEXT.test(rawText)) {
        return true;
      }
      return Boolean(node.querySelector('a[href*="/issues/"]'));
    });
  }

  function findActivityContextNode(node) {
    return node.closest("dt, dd, li, article, tr, h4, .event, .activity-item, .journal, [class*='event']")
      || node.parentElement
      || node;
  }

  /**
   * 活动流专用：dd/dt/li 不对全文做 ISO 匹配，否则正文中先出现的 “2018-1-1” 等会当作活动日，导致同页其它日期分组整段漏计。
   * dl/ul 等对整块文本取第一条日期的逻辑同样会跳过真正的日标题（h3），这里一律不解析整块列表。
   */
  function parseDateInActivityTree(el) {
    if (!el) {
      return "";
    }
    const tag = (el.tagName || "").toLowerCase();
    if (["dl", "ul", "ol", "table", "tbody", "thead", "tr", "tfoot"].includes(tag)) {
      return "";
    }
    if (tag === "dd" || tag === "dt" || tag === "li") {
      const t = el.querySelector("time[datetime]");
      if (t?.getAttribute("datetime")) {
        return t.getAttribute("datetime").slice(0, 10);
      }
      return "";
    }
    if (el.getAttribute && /^(\d{4}-\d{2}-\d{2})/.test(el.getAttribute("data-date") || "")) {
      return (el.getAttribute("data-date") || "").slice(0, 10);
    }
    const asHeading = el.matches("h1, h2, h3, h4, h5, h6");
    if (asHeading) {
      return parseDate(el);
    }
    const firstHeading = el.querySelector?.(
      ":scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6, :scope > time[datetime]"
    );
    if (firstHeading) {
      if (firstHeading.matches("time[datetime]")) {
        return (firstHeading.getAttribute("datetime") || "").slice(0, 10);
      }
      return parseDate(firstHeading);
    }
    return "";
  }

  function findActivityDate(node) {
    let current = findActivityContextNode(node);
    while (current) {
      let sibling = current.previousElementSibling;
      while (sibling) {
        const fromSibling = parseDateInActivityTree(sibling);
        if (fromSibling) {
          return fromSibling;
        }
        const innerHead = sibling.querySelector?.("h1, h2, h3, h4, h5, h6, time[datetime], .date, .group-date, .day-title");
        if (innerHead) {
          const d = innerHead.matches("time[datetime]")
            ? (innerHead.getAttribute("datetime") || "").slice(0, 10)
            : parseDate(innerHead);
          if (d) {
            return d;
          }
        }
        sibling = sibling.previousElementSibling;
      }

      const own = parseDateInActivityTree(current);
      if (own) {
        return own;
      }

      current = current.parentElement;
    }
    return "";
  }

  function parseOperator(element) {
    const userLink =
      element.querySelector("a.user") ||
      element.querySelector(".user") ||
      element.querySelector("a[href*='/users/']");
    if (userLink) {
      return text(userLink);
    }

    const raw = text(element);
    const beforeDate = raw.split(/\d{4}[-/年]\d{1,2}[-/月]\d{1,2}/)[0];
    return beforeDate
      .replace(/^#?\d+\s*/, "")
      .replace(/更新于|发表于|由|added by|updated by/gi, "")
      .trim();
  }

  function parseDate(element) {
    const fromAttrs = parseDateFromAttributes(element);
    if (fromAttrs) {
      return fromAttrs;
    }

    const raw = text(element);
    return parseDateFromText(raw) || "";
  }

  function parseDateFromAttributes(element) {
    if (!element) {
      return "";
    }
    const nodes = uniqueNodes([
      element,
      ...Array.from(element.querySelectorAll?.("time[datetime], [datetime], [title], [data-date], [data-time]") || [])
    ]);
    for (const node of nodes) {
      const values = [
        node.getAttribute?.("datetime"),
        node.getAttribute?.("title"),
        node.getAttribute?.("data-date"),
        node.getAttribute?.("data-time")
      ].filter(Boolean);
      for (const value of values) {
        const parsed = parseDateFromText(value);
        if (parsed) {
          return parsed;
        }
      }
    }
    return "";
  }

  function parseDateFromText(rawText) {
    const raw = String(rawText || "");
    const iso = raw.match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/);
    if (iso) {
      return normalizeDate(iso[0]);
    }
    const zh = raw.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (zh) {
      return `${zh[1]}-${zh[2].padStart(2, "0")}-${zh[3].padStart(2, "0")}`;
    }
    const relative = parseRelativeDay(raw);
    if (relative) {
      return relative;
    }
    return "";
  }

  function normalizeDate(value) {
    const [year, month, day] = value.replace(/\//g, "-").split("-");
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  function shiftDate(dayOffset) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + dayOffset);
    const y = String(d.getFullYear());
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function parseRelativeDay(raw) {
    const t = String(raw || "").trim();
    if (!t) {
      return "";
    }
    if (/^今天(?:\s|$)/.test(t)) {
      return shiftDate(0);
    }
    if (/^昨天(?:\s|$)/.test(t)) {
      return shiftDate(-1);
    }
    if (/^前天(?:\s|$)/.test(t)) {
      return shiftDate(-2);
    }

    const zh = t.match(/(?:约|大约|超过|将近|不到)?\s*(\d+)\s*(分钟|分|小时|小時|时|天|日|周|星期|个月|月|年)前/);
    if (zh?.[1] && zh?.[2]) {
      return shiftRelativeDate(Number(zh[1]), zh[2]);
    }

    const en = t.match(/(?:about|over|almost|less than)?\s*(\d+)\s*(minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years)\s+ago/i);
    if (en?.[1] && en?.[2]) {
      return shiftRelativeDate(Number(en[1]), en[2].toLowerCase());
    }
    return "";
  }

  function shiftRelativeDate(amount, unit) {
    if (!Number.isFinite(amount)) {
      return "";
    }
    const d = new Date();
    if (/分钟|分|minute/.test(unit)) {
      d.setMinutes(d.getMinutes() - amount);
    } else if (/小时|小時|时|hour/.test(unit)) {
      d.setHours(d.getHours() - amount);
    } else if (/天|日|day/.test(unit)) {
      d.setDate(d.getDate() - amount);
    } else if (/周|星期|week/.test(unit)) {
      d.setDate(d.getDate() - amount * 7);
    } else if (/个月|月|month/.test(unit)) {
      d.setMonth(d.getMonth() - amount);
    } else if (/年|year/.test(unit)) {
      d.setFullYear(d.getFullYear() - amount);
    } else {
      return "";
    }
    const y = String(d.getFullYear());
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  /** 从详情页 DOM 取跟踪类型 / 工单类型（Redmine 常见为 h2「支持 #123 - 标题」或 .tracker 链接） */
  function extractTrackerFromIssueDoc(doc) {
    const h2t = text(doc.querySelector("h2"));
    if (h2t) {
      const m = h2t.match(/^\s*([^\d#]+?)\s*#\d+\b/);
      if (m?.[1]) {
        const s = normalizeWhitespace(m[1])
          .replace(/^[-–—:：\s]+/, "")
          .trim();
        if (s && !/^\d+$/.test(s) && s.length <= 32) {
          return s;
        }
      }
    }
    const byClass = doc.querySelector(
      "div.issue a.tracker, .issue .tracker a, a.tracker[href*='issues'], .id .tracker a, .breadcrumb a.tracker, [class~='issue'] .tracker a"
    );
    const t = text(byClass);
    if (t) {
      return normalizeWhitespace(t).slice(0, 32);
    }
    return "";
  }

  /** 活动行「Support #123」「BUG #456」「支持 #123」等 */
  function extractTrackerFromActivityText(rawText, issueId) {
    if (!rawText || !issueId) {
      return "";
    }
    const id = String(issueId);
    const re1 = new RegExp(
      "(?:^|[\\s\\-—:：\\[（【/／])" +
        "(BUG|Support|Bug|Feature|Task|Patch|Epic|Story|" +
        "需求|支持|建议|缺陷|任务|子任务|改进|新功能|问题|故障|咨询|维护|功能|" +
        "[A-Z][A-Za-z]{1,18}|[\u4e00-\u9fff]{2,6})" +
        `\\s*[#＃]${escapeRegExp(id)}\\b`,
      "i"
    );
    const m1 = rawText.match(re1);
    if (m1?.[1]) {
      const t = normalizeWhitespace(m1[1]);
      if (t && t.length <= 24) {
        return t;
      }
    }
    return "";
  }

  function countRowsByTracker(rows) {
    const map = new Map();
    for (const row of rows) {
      const key = (row.tracker && String(row.tracker).trim()) || "未分类";
      map.set(key, (map.get(key) || 0) + 1);
    }
    return Object.fromEntries(
      [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh-Hans-CN", { numeric: true }))
    );
  }

  function buildBugDemandRatio(rows) {
    let bugCount = 0;
    let demandCount = 0;
    for (const row of rows || []) {
      if (String(row?.title || "").includes("代码质控")) {
        continue;
      }
      const tracker = String(row?.tracker || "").trim();
      if (!tracker) {
        continue;
      }
      const lower = tracker.toLowerCase();
      if (/bug|缺陷|故障|问题/.test(lower) || /bug|缺陷|故障|问题/.test(tracker)) {
        bugCount += 1;
      }
      if (/需求|feature|story|epic/.test(lower) || /需求/.test(tracker)) {
        demandCount += 1;
      }
    }
    if (bugCount === 0 && demandCount === 0) {
      return null;
    }
    const ratioValue = demandCount === 0 ? "∞" : (bugCount / demandCount).toFixed(1);
    return {
      ratioValue,
      bugCount,
      demandCount
    };
  }

  /** 按所选月份分别统计各工单类型条数 */
  function countRowsByMonthAndTracker(selectedMonths, rows) {
    const months = (selectedMonths || []).slice().sort();
    const perMonth = {};
    for (const m of months) {
      perMonth[m] = new Map();
    }
    for (const row of rows) {
      const mk = row.monthKey || (row.firstChangedAt && row.firstChangedAt.slice(0, 7));
      if (!mk || !perMonth[mk]) {
        continue;
      }
      const key = (row.tracker && String(row.tracker).trim()) || "未分类";
      const map = perMonth[mk];
      map.set(key, (map.get(key) || 0) + 1);
    }
    return months.map((m) => {
      const map = perMonth[m] || new Map();
      const types = Object.fromEntries(
        [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh-Hans-CN", { numeric: true }))
      );
      const total = Object.values(types).reduce((a, b) => a + b, 0);
      return { monthKey: m, types, total };
    });
  }

  function buildActivityTitle(rawText, issueId) {
    const normalized = normalizeWhitespace(rawText)
      .replace(/^\d{1,2}:\d{2}\s*/, "")
      .trim();

    if (!normalized) {
      return "";
    }

    if (!issueId) {
      return normalized;
    }

    return normalized
      .replace(new RegExp(`^.*?#${escapeRegExp(issueId)}\\s*`), "")
      .trim();
  }

  function sameUser(actual, expected) {
    return normalizeUserName(actual) === normalizeUserName(expected);
  }

  function detectCurrentUserName(doc = document) {
    const activityOwner = detectActivityOwnerName(doc);
    if (activityOwner) {
      return activityOwner;
    }

    const loginAlias = detectLoginAlias(doc);
    if (loginAlias) {
      return loginAlias;
    }

    const selectors = [
      "#loggedas a.user",
      ".loggedas a.user",
      "#top-menu a.user",
      ".current-user"
    ];
    for (const selector of selectors) {
      const value = text(doc.querySelector(selector));
      if (value) {
        return value;
      }
    }
    return "";
  }

  /** 从顶栏「登录为」用户链接解析 /users/123 */
  function detectCurrentUserId(doc = document) {
    const selectors = [
      "#loggedas a.user",
      ".loggedas a.user",
      "#top-menu a.user",
      "#account a.user",
      "a.user.active"
    ];
    for (const selector of selectors) {
      const nodes = Array.from(doc.querySelectorAll(selector));
      for (const node of nodes) {
        const href = node.getAttribute("href") || "";
        const match = href.match(/\/users\/(\d+)(?:\/|$|\?)/);
        if (match?.[1]) {
          return match[1];
        }
      }
    }

    const loggedAs = doc.querySelector("#loggedas, .loggedas, #account");
    if (loggedAs) {
      const link = loggedAs.querySelector('a[href*="/users/"]');
      const href = link?.getAttribute("href") || "";
      const match = href.match(/\/users\/(\d+)(?:\/|$|\?)/);
      if (match?.[1]) {
        return match[1];
      }
    }
    return "";
  }

  function detectActivityOwnerName(doc = document) {
    const match = Array.from(doc.querySelectorAll("h1, h2, h3"))
      .map((node) => text(node))
      .map((value) => value.match(/^(.+?)\s*的活动$/))
      .find(Boolean);
    return match?.[1] || "";
  }

  function detectLoginAlias(doc = document) {
    const selectors = ["#loggedas", ".loggedas", "#top-menu", "#account", "header", "body"];
    for (const selector of selectors) {
      const node = doc.querySelector(selector);
      const match = text(node).match(/登录为\s*([A-Za-z0-9_.@-]+)/i);
      if (match?.[1]) {
        return match[1];
      }
    }
    return "";
  }

  function normalizeUserName(value) {
    return String(value ?? "")
      .replace(/^登录为\s*/i, "")
      .replace(/\s*的活动$/, "")
      .replace(/我的帐号.*$/, "")
      .replace(/[（(].*$/, "")
      .replace(/\s+/g, "")
      .toLowerCase()
      .trim();
  }

  function setBusy(panel, busy) {
    const hasRows = getLastRows(panel).length > 0;
    panel.querySelector('[data-action="scan"]').disabled = busy;
    panel.querySelector('[data-action="detailed-scan"]').disabled = busy;
    panel.querySelector('[data-action="stop"]').disabled = !busy;
    const expHtml = panel.querySelector('[data-action="export-html"]');
    if (expHtml) {
      expHtml.disabled = busy || !hasRows;
    }
  }

  function setStatus(panel, message, isError = false) {
    const node = panel.querySelector('[data-role="status"]');
    node.textContent = message;
    node.classList.toggle("kb-workload-error", isError);
  }

  function setDetailedProgress(panel, progress, rowsCount, currentUrl = "") {
    const node = panel.querySelector('[data-role="status"]');
    const total = Math.max(1, Number(progress.total) || 0);
    const completed = Math.min(total, Number(progress.completed) || 0);
    const percent = Math.round((completed / total) * 100);
    node.classList.remove("kb-workload-error");
    node.innerHTML = `<div class="kb-workload-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}">
      <div class="kb-workload-progress-head">
        <span>正在查询工单详情</span>
        <strong>${escapeHtml(String(completed))}/${escapeHtml(String(progress.total || 0))} · ${escapeHtml(String(percent))}%</strong>
      </div>
      <div class="kb-workload-progress-track"><div class="kb-workload-progress-fill" style="width:${percent}%;"></div></div>
      <div class="kb-workload-progress-detail">已结算 ${escapeHtml(String(rowsCount))} 条，解析到状态历史 ${escapeHtml(String(progress.withTimeline || 0))} 个，失败 ${escapeHtml(String(progress.failed || 0))} 个${currentUrl ? `；当前：${escapeHtml(currentUrl)}` : ""}</div>
    </div>`;
  }

  function buildMonthlyStats(selectedMonths, rows) {
    const months = (selectedMonths || []).slice().sort();
    const counts = {};
    months.forEach((m) => {
      counts[m] = 0;
    });
    for (const row of rows) {
      const mk = row.monthKey || (row.firstChangedAt && row.firstChangedAt.slice(0, 7));
      if (mk && Object.prototype.hasOwnProperty.call(counts, mk)) {
        counts[mk] += 1;
      }
    }
    const total = months.reduce((s, m) => s + (counts[m] || 0), 0);
    const series = months.map((m, i) => {
      const c = counts[m] || 0;
      const pct = total > 0 ? ((c / total) * 100).toFixed(1) : "0.0";
      let momLabel = "—";
      if (i > 0) {
        const prev = counts[months[i - 1]] || 0;
        if (prev === 0) {
          momLabel = c > 0 ? "新增" : "0%";
        } else {
          const d = (c - prev) / prev;
          momLabel = `${d >= 0 ? "+" : ""}${(d * 100).toFixed(1)}%`;
        }
      }
      return { month: m, count: c, percent: pct, mom: momLabel };
    });
    return { counts, series, total, months };
  }

  function renderMonthChart(panel, selectedMonths, rows) {
    const el = panel.querySelector('[data-role="month-chart"]');
    if (!el) {
      return;
    }
    const months = selectedMonths && selectedMonths.length > 0 ? selectedMonths : [];
    const rowList = rows && rows.length > 0 ? rows : [];
    const showChart = months.length > 0 && rowList.length > 0;
    if (!showChart) {
      el.innerHTML = "";
      el.classList.add("kb-workload-month-chart--hidden");
      return;
    }
    el.classList.remove("kb-workload-month-chart--hidden");
    const stats = buildMonthlyStats(months, rowList);
    const max = Math.max(1, ...stats.months.map((m) => stats.counts[m] || 0));

    function panelMomClass(mom) {
      const m = String(mom ?? "");
      if (m === "—") {
        return "kb-workload-bar-m--neutral";
      }
      if (m.startsWith("-") && m.length > 1) {
        return "kb-workload-bar-m--down";
      }
      if (m.startsWith("+") || m === "新增") {
        return "kb-workload-bar-m--up";
      }
      return "kb-workload-bar-m--neutral";
    }

    const bars = stats.series
      .map((item, i) => {
        const w = 100 / Math.max(1, stats.months.length);
        const h = (item.count / max) * 100;
        const mn = (item.month || "").slice(5, 7);
        const mNum = String(Number(mn) || 0);
        const momCls = panelMomClass(item.mom);
        const momLine =
          i > 0
            ? `<span class="kb-workload-bar-m ${momCls}">环比 ${escapeHtml(item.mom)}</span>`
            : "";
        const tip =
          i > 0
            ? `${escapeHtml(item.month)}: ${item.count} 条，环比 ${escapeHtml(item.mom)}`
            : `${escapeHtml(item.month)}: ${item.count} 条`;
        return `
        <div class="kb-workload-bar-col" style="width:${w}%; --bar-delay:${i * 45}ms;" title="${tip}">
          <div class="kb-workload-bar-viz" aria-hidden="true">
            <div class="kb-workload-bar-track">
              <div class="kb-workload-bar-fill" data-target-height="${h}" style="height:0%;"></div>
            </div>
          </div>
          <div class="kb-workload-bar-meta">
            <span class="kb-workload-bar-nums">
              <span class="kb-workload-bar-c">${escapeHtml(String(item.count))}</span>
            </span>
            ${momLine}
          </div>
          <div class="kb-workload-bar-x"><span class="kb-workload-bar-x-inner">${escapeHtml(mNum)} 月</span></div>
        </div>`;
      })
      .join("");
    el.innerHTML = `<div class="kb-workload-chart-card">
      <div class="kb-workload-chart-head">
        <span class="kb-workload-chart-title">各月条数与环比</span>
      </div>
      <div class="kb-workload-chart-bars" role="img" aria-label="各月工单条数与环比">${bars}</div>
    </div>`;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.querySelectorAll(".kb-workload-bar-fill[data-target-height]").forEach((fill) => {
          const target = Number(fill.getAttribute("data-target-height")) || 0;
          fill.style.height = `${target}%`;
        });
        el.querySelectorAll(".kb-workload-bar-col").forEach((col) => {
          col.classList.add("is-in");
        });
        el.querySelector(".kb-workload-chart-card")?.classList.add("is-in");
      });
    });
  }

  function renderSummary(panel, summary) {
    const by = countRowsByTracker(summary.rows || []);
    const bugDemandRatio = buildBugDemandRatio(summary.rows || []);
    const typeParts = Object.keys(by).length
      ? Object.entries(by).map(([k, v]) => `${escapeHtml(k)} ${escapeHtml(String(v))} 个`)
      : [];
    const typeLine = typeParts.length
      ? `<div class="kb-workload-type-breakdown">按类型：${typeParts.join("；")}。</div>`
      : "";
    const ratioLine = bugDemandRatio
      ? `<div class="kb-workload-ratio-highlight">
          <span class="kb-workload-ratio-label">BUG/需求</span>
          <span class="kb-workload-ratio-value">${escapeHtml(bugDemandRatio.ratioValue)}</span>
          <span class="kb-workload-ratio-detail">(${escapeHtml(String(bugDemandRatio.bugCount))}/${escapeHtml(String(bugDemandRatio.demandCount))})</span>
        </div>`
      : "";
    const titleM = summary.monthLabel || "所选月份";
    panel.querySelector('[data-role="summary"]').innerHTML = `
      <strong>${escapeHtml(titleM)} · ${escapeHtml(summary.username)}：共 ${escapeHtml(String(summary.total))} 条</strong>
      ${typeLine}
      ${ratioLine}
    `;
  }

  function renderResults(panel, rows) {
    setLastRows(panel, rows);
    const dis = rows.length === 0 || Boolean(activeScan);
    const exH = panel.querySelector('[data-action="export-html"]');
    if (exH) {
      exH.disabled = dis;
    }
    const container = panel.querySelector('[data-role="results"]');
    if (rows.length === 0) {
      container.innerHTML = '<div class="kb-workload-empty">暂无结果</div>';
      return;
    }
    container.innerHTML = "";
  }

  function setLastRows(panel, rows) {
    panel.__kbWorkloadRows = rows;
  }

  function getLastRows(panel) {
    return panel.__kbWorkloadRows || [];
  }

  function downloadHtmlReport(selectedMonths, rows, username, scope) {
    const mStats = buildMonthlyStats(selectedMonths || [], rows);
    const max = Math.max(1, ...mStats.months.map((m) => mStats.counts[m] || 0));
    const byMonthType = countRowsByMonthAndTracker(selectedMonths || [], rows);

    function typeIconKind(tracker) {
      const t = String(tracker || "");
      const lower = t.toLowerCase();
      if (/bug|缺陷/.test(t) || /bug|缺陷/.test(lower)) {
        return "bug";
      }
      if (t.includes("需求")) {
        return "req";
      }
      if (t.includes("建议")) {
        return "sug";
      }
      if (t.includes("支持")) {
        return "sup";
      }
      return "def";
    }

    const icons = {
      bug: '<span class="tic tic-bug" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 1.3 7 0M15.5 1.3 17 0"/><circle cx="12" cy="5" r="2.5"/><ellipse cx="12" cy="14" rx="4" ry="5.5"/><path d="M4.5 8l2.3 1.3M2.5 12H7M4.5 16l2.3-1.2M19.5 8l-2.3 1.3M21.5 12H17M19.5 16l-2.3-1.2M9.2 20l-.6 2.6M12 19v3M14.8 20l.6 2.6"/></span>',
      req: '<span class="tic tic-req" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 2h9l3 3v17H6V2Z" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M9 7h6M9 11h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></span>',
      sug: '<span class="tic tic-sug" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 4h16v12H9l-4 4v-4H4V4Z" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linejoin="round"/></svg></span>',
      sup: '<span class="tic tic-sup" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 10v6a2 2 0 0 0 2 2h.5A2.5 2.5 0 0 0 12 15.5V10M7 10H5.5A2.5 2.5 0 0 0 3 12.5V14h4M7 10h10M17 10h1.5A2.5 2.5 0 0 1 21 12.5V14h-4M9 2v4h6V2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg></span>',
      def: '<span class="tic tic-def" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" stroke-width="1.4" fill="none"/></svg></span>'
    };

    function htmlTypeLabel(tracker) {
      const k = typeIconKind(tracker);
      return `<span class="type-with-icon">${icons[k] || icons.def}<span class="type-name">${escapeHtml(tracker)}</span></span>`;
    }

    function htmlMomCell(mom) {
      const m = String(mom ?? "");
      if (m === "—" || m === "-") {
        return '<span class="mom-muted">—</span>';
      }
      if (m === "新增") {
        return '<span class="mom-pos">新增</span>';
      }
      if (m.startsWith("+")) {
        return `<span class="mom-pos">${escapeHtml(m)}</span>`;
      }
      if (m.startsWith("-")) {
        return `<span class="mom-neg">${escapeHtml(m)}</span>`;
      }
      return `<span class="mom-neu">${escapeHtml(m)}</span>`;
    }

    const barRows = mStats.series
      .map((s) => {
        const h = (s.count / max) * 100;
        return `<tr>
  <td>${escapeHtml(s.month)}</td>
  <td class="t-num">${s.count}</td>
  <td class="t-num">${escapeHtml(s.percent)}%</td>
  <td class="t-mom">${htmlMomCell(s.mom)}</td>
  <td class="t-bar"><div class="hbar" role="img" aria-label="柱形：${s.count}"><div class="hbar-track"><div class="hbar-fill" style="width:${h}%"></div></div></div></td>
</tr>`;
      })
      .join("");

    const monthTypeBlocks = byMonthType
      .map((block) => {
        const keys = Object.keys(block.types);
        const typeRows = keys.length
          ? keys
              .map(
                (k) =>
                  `<tr><td class="td-type">${htmlTypeLabel(k)}</td><td class="t-num">${block.types[k]}</td></tr>`
              )
              .join("")
          : '<tr><td colspan="2" class="td-empty">该月无命中记录</td></tr>';
        const mLabel = block.monthKey || "";
        const mTitle =
          mLabel.length >= 7
            ? `${mLabel.slice(0, 4)} 年 ${Number(mLabel.slice(5, 7))} 月`
            : escapeHtml(mLabel);
        const monthRows = (rows || []).filter((r) => (r.monthKey || (r.firstChangedAt && r.firstChangedAt.slice(0, 7))) === block.monthKey);
        const ratio = buildBugDemandRatio(monthRows);
        const ratioLine = ratio
          ? `<div class="month-ratio">BUG/需求：<strong>${escapeHtml(ratio.ratioValue)}</strong> <span class="month-ratio-detail">(${escapeHtml(String(ratio.bugCount))}/${escapeHtml(String(ratio.demandCount))})</span></div>`
          : "";
        return `<div class="month-block">
  <h3 class="subhead"><span class="section-accent sm"></span>${mTitle} · 按类型</h3>
  ${ratioLine}
  <table class="tbl tbl-compact"><thead><tr><th>类型</th><th>条数</th></tr></thead><tbody>${typeRows}</tbody></table>
</div>`;
      })
      .join("");

    const tableRows = sortRows(rows)
      .map(
        (row) => `<tr>
  <td>${escapeHtml(row.monthKey || (row.firstChangedAt && row.firstChangedAt.slice(0, 7)) || "")}</td>
  <td class="t-num">${escapeHtml(String(row.issueId))}</td>
  <td class="td-type">${htmlTypeLabel((row.tracker && String(row.tracker).trim()) || "未分类")}</td>
  <td>${escapeHtml(row.matchedStatuses)}</td>
  <td class="t-time">${escapeHtml(row.firstChangedAt)}</td>
</tr>`
      )
      .join("");

    const now = new Date();
    const genTime = escapeHtml(
      `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`
    );

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>FZ 工单工作量报表</title>
<style>
  :root {
    --ink: #1f2937;
    --muted: #64748b;
    --line: #e2e8f0;
    --thead: #f8f9fa;
    --card: #ffffff;
    --page: #f0f2f5;
    --blue: #1890ff;
    --green: #52c41a;
    --red: #f5222d;
    --orange: #e65a28;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    color: var(--ink);
    background: var(--page);
  }
  .page { max-width: 1040px; margin: 0 auto; padding: 32px 24px 48px; }
  .card {
    background: var(--card);
    border: 1px solid #e4e7ec;
    border-radius: 8px;
    padding: 20px 22px 22px;
    margin-bottom: 20px;
    box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  }
  .report-header {
    display: flex;
    align-items: flex-start;
    gap: 16px;
    margin-bottom: 24px;
  }
  .report-icon-wrap {
    width: 44px;
    height: 44px;
    border-radius: 8px;
    background: var(--blue);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .report-icon-wrap svg { display: block; }
  h1 {
    font-size: 22px;
    font-weight: 700;
    margin: 0 0 6px;
    color: #111827;
    letter-spacing: -0.02em;
  }
  .meta { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.5; }
  .section-title {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 15px;
    font-weight: 600;
    color: #111827;
    margin: 0 0 16px;
  }
  .section-accent {
    width: 4px;
    height: 18px;
    background: var(--blue);
    border-radius: 2px;
    flex-shrink: 0;
  }
  .section-accent.sm { height: 16px; }
  .subhead {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    font-weight: 600;
    color: #334155;
    margin: 0 0 10px;
  }
  .month-block { margin-bottom: 20px; }
  .month-block:last-child { margin-bottom: 0; }
  .month-ratio {
    margin: 0 0 10px;
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 999px;
    background: #fff7ed;
    border: 1px solid #fed7aa;
    color: #9a3412;
    font-size: 12px;
    font-weight: 600;
  }
  .month-ratio strong { font-size: 15px; color: #c2410c; }
  .month-ratio-detail { color: #b45309; font-weight: 500; }
  .tbl { width: 100%; border-collapse: collapse; }
  .tbl th {
    text-align: left;
    font-size: 12px;
    font-weight: 600;
    color: #475569;
    background: var(--thead);
    padding: 10px 12px;
    border-bottom: 1px solid var(--line);
  }
  .tbl td {
    padding: 12px 12px;
    border-bottom: 1px solid var(--line);
    vertical-align: middle;
  }
  .tbl tbody tr:last-child td { border-bottom: none; }
  .tbl-compact th, .tbl-compact td { padding: 9px 10px; }
  .t-num { font-variant-numeric: tabular-nums; }
  .t-mom { font-variant-numeric: tabular-nums; }
  .mom-pos { color: var(--red); font-weight: 600; }
  .mom-neg { color: var(--green); font-weight: 600; }
  .mom-neu, .mom-muted { color: #94a3b8; }
  .t-bar { width: 32%; min-width: 120px; }
  .hbar { width: 100%; }
  .hbar-track {
    height: 10px;
    border-radius: 5px;
    background: #e8ecf0;
    overflow: hidden;
  }
  .hbar-fill {
    height: 100%;
    min-width: 0;
    border-radius: 5px;
    background: linear-gradient(90deg, #f07840, var(--orange));
  }
  .type-with-icon { display: inline-flex; align-items: center; gap: 8px; }
  .td-type .tic, .td-type .type-name { display: inline-flex; align-items: center; }
  .tic { display: inline-flex; color: var(--tic); }
  .tic-bug { --tic: #f5222d; }
  .tic-req { --tic: #52c41a; }
  .tic-sug { --tic: #1890ff; }
  .tic-sup { --tic: #e65a28; }
  .tic-def { --tic: #94a3b8; }
  .type-name { font-weight: 500; }
  .td-empty { color: #94a3b8; font-size: 13px; text-align: center; padding: 16px; }
  .t-time { font-size: 13px; color: #475569; white-space: nowrap; }
  .month-type-wrap { display: flex; flex-direction: column; gap: 0; }
</style>
</head>
<body>
  <div class="page">
    <header class="report-header">
      <div class="report-icon-wrap" aria-hidden="true">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M7 3h8l4 4v14H7V3Z" stroke="white" stroke-width="1.6" fill="none" stroke-linejoin="round"/>
          <path d="M9 8h6M9 12h4" stroke="white" stroke-width="1.3" stroke-linecap="round"/>
        </svg>
      </div>
      <div>
        <h1>FZ 工单工作量统计</h1>
        <p class="meta">操作者：${escapeHtml(username || "—")} · 范围：${escapeHtml(scope || "—")} · 生成时间：${genTime}</p>
      </div>
    </header>

    <section class="card">
      <h2 class="section-title"><span class="section-accent"></span>分月条数、占比、环比</h2>
      <table class="tbl">
        <thead>
          <tr>
            <th>月份</th>
            <th>条数</th>
            <th>占全部</th>
            <th>环比</th>
            <th>柱形</th>
          </tr>
        </thead>
        <tbody>${barRows}</tbody>
      </table>
    </section>

    <section class="card">
      <h2 class="section-title"><span class="section-accent"></span>按类型汇总（分月）</h2>
      <div class="month-type-wrap">${monthTypeBlocks}</div>
    </section>

    <section class="card">
      <h2 class="section-title"><span class="section-accent"></span>明细</h2>
      <table class="tbl">
        <thead>
          <tr>
            <th>所属月份</th>
            <th>工单ID</th>
            <th>类型</th>
            <th>命中状态</th>
            <th>时间</th>
          </tr>
        </thead>
        <tbody>${tableRows || '<tr><td colspan="5" class="td-empty">暂无数据</td></tr>'}</tbody>
      </table>
    </section>
  </div>
</body>
</html>`;

    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const u = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = u;
    a.download = `kb-workload-report-${new Date().toISOString().slice(0, 10)}.html`;
    a.click();
    URL.revokeObjectURL(u);
  }

  function text(node) {
    return node?.textContent?.trim() || "";
  }

  function unique(values) {
    return Array.from(new Set(values.filter(Boolean)));
  }

  function uniqueNodes(nodes) {
    return Array.from(new Set(Array.from(nodes)));
  }

  function sortRows(rows) {
    return [...rows].sort((left, right) => {
      const lm = left.monthKey || (left.firstChangedAt && left.firstChangedAt.slice(0, 7)) || "";
      const rm = right.monthKey || (right.firstChangedAt && right.firstChangedAt.slice(0, 7)) || "";
      if (lm !== rm) {
        return lm.localeCompare(rm);
      }
      if (left.orderIndex !== right.orderIndex) {
        return left.orderIndex - right.orderIndex;
      }
      return String(left.issueId).localeCompare(String(right.issueId), "zh-Hans-CN", { numeric: true });
    });
  }

  function normalizeWhitespace(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
})();
