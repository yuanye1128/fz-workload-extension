/**
 * 详细统计：短路径与当月已完成跳过
 * 运行: node test/cross-month-detailed.test.js
 */

function isInSelectedMonths(dateStr, months) {
  if (!dateStr || !months || months.length === 0) {
    return false;
  }
  return months.some((m) => dateStr.startsWith(m));
}

function earliestMonthFirstDay(months) {
  if (!months || months.length === 0) {
    return "";
  }
  return `${months.slice().sort()[0]}-01`;
}

/** 活动页候选往前看：最早勾选月往前 1 个月的 1 号 */
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

function shouldCollectDetailedActivityCandidate(dateStr, months, statuses) {
  if (!dateStr) {
    return false;
  }
  if (isInSelectedMonths(dateStr, months)) {
    return true;
  }
  const lookbackStart = activityLookbackStart(months);
  const monthStart = earliestMonthFirstDay(months);
  if (!lookbackStart || !monthStart) {
    return false;
  }
  if (dateStr < lookbackStart || dateStr >= monthStart) {
    return false;
  }
  return Array.isArray(statuses) && statuses.includes("待测试");
}

function settleDetailedIssueRows(detail, issueUrl, selectedMonths, username, orderIndex, timeline) {
  const monthSet = new Set(selectedMonths || []);
  const rows = [];
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
      contributors.set(change.operator, {
        operator: change.operator,
        changedAt: change.changedAt
      });
    });
    contributors.set(completion.operator, {
      operator: completion.operator,
      changedAt: completion.changedAt,
      completedBySelf: true
    });

    if (monthSet.has(monthKey)) {
      for (const contributor of contributors.values()) {
        if (contributor.operator !== username) {
          continue;
        }
        const rowKey = `${detail.issueId}|${contributor.operator}|${monthKey}`;
        if (rowKeys.has(rowKey)) {
          continue;
        }
        rowKeys.add(rowKey);
        rows.push({
          issueId: detail.issueId,
          monthKey,
          matchedStatuses: contributor.completedBySelf ? "已完成" : "待测试 → 已完成",
          operator: contributor.operator,
          contributionChangedAt: contributor.changedAt,
          settledAt: completion.changedAt
        });
      }
    }

    cycleStart = completion.changedAt;
  }

  return rows;
}

function normalizeUserName(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function sameUser(actual, expected) {
  return normalizeUserName(actual) === normalizeUserName(expected);
}

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
      url: item.url || "",
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

function assert(cond, msg) {
  if (!cond) {
    throw new Error(msg);
  }
}

function run() {
  // 勾选月内照常收录
  assert(
    shouldCollectDetailedActivityCandidate("2026-07-20", ["2026-07"], ["已完成"]) === true,
    "勾选月内活动应收录"
  );

  // 往前多看 1 个月：仅勾选 7 月时，6 月待测试应收录
  assert(activityLookbackStart(["2026-07"]) === "2026-06-01", "lookback 应为最早勾选月往前 1 个月");
  assert(
    shouldCollectDetailedActivityCandidate("2026-06-15", ["2026-07"], ["待测试"]) === true,
    "仅勾选 7 月时，仍应收录 6 月的待测试活动作为候选"
  );
  assert(
    shouldCollectDetailedActivityCandidate("2026-06-15", ["2026-07"], ["已完成"]) === false,
    "勾选月之前的已完成活动不应仅为 lookback 收录"
  );
  assert(
    shouldCollectDetailedActivityCandidate("2026-05-31", ["2026-07"], ["待测试"]) === false,
    "超出 lookback 的待测试不应收录"
  );

  // 结算：详情里 6 月待测试 + 7 月已完成，仅勾选 7 月仍可计入
  const settled = settleDetailedIssueRows(
    { issueId: "1001", title: "t", tracker: "" },
    "https://kb.example/issues/1001",
    ["2026-07"],
    "A",
    0,
    [
      { operator: "A", changedAt: "2026-06-10", status: "待测试" },
      { operator: "B", changedAt: "2026-07-05", status: "已完成" }
    ]
  );
  assert(settled.length === 1, "应结算出 1 条");
  assert(settled[0].monthKey === "2026-07", "应计入已完成所在的 7 月");
  assert(settled[0].operator === "A", "应计给 6 月改待测试的 A");

  // 已完成短路径
  const shortcut = buildCompletedActivityShortcutRows(
    [
      {
        issueId: "2001",
        url: "https://kb.example/issues/2001",
        date: "2026-07-08",
        statuses: ["已完成"],
        title: "done",
        tracker: "缺陷",
        operator: "A",
        orderIndex: 0
      },
      {
        issueId: "2002",
        url: "https://kb.example/issues/2002",
        date: "2026-07-09",
        statuses: ["待测试"],
        title: "testing",
        operator: "A",
        orderIndex: 1
      },
      {
        issueId: "2003",
        url: "https://kb.example/issues/2003",
        date: "2026-06-20",
        statuses: ["已完成"],
        title: "old",
        operator: "A",
        orderIndex: 2
      }
    ],
    ["2026-07"],
    "A"
  );
  assert(shortcut.rows.length === 1, "仅勾选月内已完成应短路径 1 条");
  assert(shortcut.rows[0].issueId === "2001", "短路径应记 2001");
  assert(shortcut.skipIssueIds.has("2001"), "已完成工单应跳过详情");
  assert(!shortcut.skipIssueIds.has("2002"), "仅待测试不应因短路径跳过");
  assert(!shortcut.skipIssueIds.has("2003"), "非勾选月的已完成不应短路径跳过");

  // 当月已见已完成：后续历史再出现同工单应跳过
  const completedSeen = new Set();
  const history = [
    { issueId: "666666", date: "2026-07-20", statuses: ["已完成"] },
    { issueId: "666666", date: "2026-07-10", statuses: ["待测试"] },
    { issueId: "666666", date: "2026-06-15", statuses: ["待测试"] },
    { issueId: "777777", date: "2026-07-12", statuses: ["待测试"] }
  ];
  const kept = [];
  for (const item of history) {
    if (completedSeen.has(item.issueId)) {
      continue;
    }
    if (!shouldCollectDetailedActivityCandidate(item.date, ["2026-07"], item.statuses)) {
      continue;
    }
    if (item.statuses.includes("已完成") && isInSelectedMonths(item.date, ["2026-07"])) {
      completedSeen.add(item.issueId);
    }
    kept.push(`${item.issueId}@${item.date}`);
  }
  assert(kept.length === 2, "666666 仅保留首次已完成，777777 待测试仍保留");
  assert(kept[0] === "666666@2026-07-20", "先保留当月已完成");
  assert(kept[1] === "777777@2026-07-12", "其他工单不受影响");
  assert(completedSeen.has("666666"), "666666 应标记为当月已完成");

  console.log("OK: cross-month-detailed.test.js");
}

run();
