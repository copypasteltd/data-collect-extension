export async function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    const id = await chrome.downloads.download({
      url,
      filename,
      saveAs: false,
    });
    await new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        chrome.downloads.onChanged.removeListener(changed);
        chrome.downloads.onErased.removeListener(erased);
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const finish = (state, reason) => {
        if (settled || !["complete", "interrupted"].includes(state)) return;
        if (state === "interrupted") {
          fail(new Error(`下载未完成${reason ? `：${reason}` : ""}`));
          return;
        }
        settled = true;
        cleanup();
        resolve();
      };
      const changed = (delta) => {
        if (delta.id === id) finish(delta.state?.current, delta.error?.current);
      };
      const erased = (erasedId) => {
        if (erasedId === id)
          fail(new Error("下载记录已移除，无法确认是否完成"));
      };
      chrome.downloads.onChanged.addListener(changed);
      chrome.downloads.onErased.addListener(erased);
      Promise.resolve()
        .then(() => chrome.downloads.search({ id }))
        .then(([item]) => {
          if (!item) {
            fail(new Error("无法查询下载状态"));
            return;
          }
          finish(item.state, item.error);
        })
        .catch(fail);
    });
    return id;
  } finally {
    URL.revokeObjectURL(url);
  }
}
