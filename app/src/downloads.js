export async function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    const id = await chrome.downloads.download({
      url,
      filename,
      saveAs: false,
    });
    const changed = (delta) => {
      if (
        delta.id === id &&
        ["complete", "interrupted"].includes(delta.state?.current)
      ) {
        URL.revokeObjectURL(url);
        chrome.downloads.onChanged.removeListener(changed);
      }
    };
    chrome.downloads.onChanged.addListener(changed);
    const [item] = await chrome.downloads.search({ id });
    if (item && ["complete", "interrupted"].includes(item.state)) {
      URL.revokeObjectURL(url);
      chrome.downloads.onChanged.removeListener(changed);
      if (item.state === "interrupted") throw new Error("下载未完成");
    }
    return id;
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}
