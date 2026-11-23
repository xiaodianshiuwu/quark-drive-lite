(async () => {
  const checks = [], check = (name, ok) => checks.push({name, ok: !!ok});
  try {
    const readyBy = Date.now() + 25000;
    while (!window.qk || !document.getElementById('tut-btn-skip')) {
      if (Date.now() >= readyBy) throw new Error('初次启动界面未就绪');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    check('bundled interface', document.querySelector('.brand-text')?.textContent.includes('夸克网盘'));
    check('native bridge', !!window.qk && !!window.__TAURI__);
    check('quit action available', !!document.getElementById('btn-quit') && typeof window.qk.app.quit === 'function');
    check('visible interface', document.querySelector('.sidebar')?.getBoundingClientRect().width > 100 && document.querySelector('.topbar')?.getBoundingClientRect().height > 0);
    const settings = await window.qk.settings.get();
    check('Rust settings command', typeof settings.downloadDir === 'string');
    check('AI Beta defaults off', settings.aiBetaEnabled === false);
    check('askDownloadDir defaults off', settings.askDownloadDir === false);
    check('AI entries hidden when Beta off', document.getElementById('nav-chat')?.hidden === true && document.getElementById('agent-card')?.hidden === true);
    check('backup view removed', !document.querySelector('[data-view="backup"]') && !document.getElementById('view-backup'));
    const tutSkip = document.getElementById('tut-btn-skip');
    check('first-launch onboarding tutorial shown with skip action', !!tutSkip);
    if (tutSkip) { tutSkip.click(); await new Promise(r => setTimeout(r, 220)); }
    const optDecline = document.getElementById('optin-btn-decline');
    check('first-launch server opt-in modal shown after tutorial', !!optDecline);
    if (optDecline) { optDecline.click(); await new Promise(r => setTimeout(r, 120)); }
    const afterSettings = await window.qk.settings.get();
    check('tutorialSeen persisted after skip', afterSettings && afterSettings.tutorialSeen === true);
    const hubCfg = await window.qk.hub.config();
    if (window.qk.platform === 'linux') {
      check('Linux update asset', hubCfg.recommendedAssetKey === 'linux-x64-deb' || hubCfg.recommendedAssetKey === 'linux-arm64-deb');
    }
    check('hub opt-in defaults off and prompted after decline', hubCfg && hubCfg.optIn === false && hubCfg.prompted === true);
    let hubBlocked; try { await window.qk.hub.checkUpdate(); } catch (e) { hubBlocked = e.code; }
    check('hub hard-blocks network when opted out', hubBlocked === 'OPT_IN_REQUIRED');
    document.querySelector('[data-view="feedback"]').click();
    check('feedback view', !document.getElementById('view-feedback').hidden);
    document.querySelector('[data-view="files"]').click();
    const appInfo = await window.qk.app.info();
    check('Rust app info command', typeof appInfo?.version === 'string' && appInfo.version.length > 0);
    const changed = await window.qk.settings.set({theme: 'dark', downloadParallel: 48, askDownloadDir: true});
    check('Rust settings persist relaxed limits', changed.theme === 'dark' && changed.downloadParallel === 48 && changed.askDownloadDir === true && (await window.qk.settings.get()).downloadParallel === 48);
    await window.qk.settings.set({theme: settings.theme, downloadParallel: settings.downloadParallel, askDownloadDir: settings.askDownloadDir});
    const auth = await window.qk.auth.status();
    check('Rust auth status', typeof auth.loggedIn === 'boolean');
    const tasks = await window.qk.transfer.list();
    check('Rust persisted tasks', Array.isArray(tasks));
    let code; try { await window.qk.fs.list({pdirFid:'0'}); } catch (e) { code = e.code; }
    check('NEED_LOGIN error bridge', auth.loggedIn || code === 'NEED_LOGIN');
    document.querySelector('[data-view="settings"]').click();
    check('settings view', !document.querySelector('#view-settings').hidden);
    document.querySelector('[data-view="transfers"]').click();
    check('transfers view', !document.querySelector('#view-transfers').hidden);
    const agent=await window.qk.agent.status();check('Rust agent status',typeof agent.enabled==='boolean');
    const mcp=await window.qk.agent.mcpConfig();check('packaged MCP adapter path',mcp.mcpServers['quark-mini'].args[0].includes('adapters'));
    document.querySelector('[data-view="settings"]').click();
    document.querySelector('#set-ai-beta [data-ai-beta="on"]').click();
    await new Promise(r => setTimeout(r, 120));
    check('AI Beta opt-in reveals chat and agent', document.getElementById('nav-chat')?.hidden === false && document.getElementById('agent-card')?.hidden === false);
    document.querySelector('[data-view="chat"]').click();check('chat view',!document.getElementById('view-chat').hidden);
    const chat=await window.qk.chat.status();check('Rust chat status',chat.configured===false);
    document.querySelector('[data-view="settings"]').click();
    document.querySelector('#set-ai-beta [data-ai-beta="off"]').click();
    await new Promise(r => setTimeout(r, 120));
    check('AI Beta opt-out restores minimal mode', document.getElementById('nav-chat')?.hidden === true && document.getElementById('agent-card')?.hidden === true);
    document.querySelector('[data-view="files"]').click();
    check('no mock data', !location.search.includes('mock=1'));
    if (window.__qkSmokeDesktop) {
      const source = window.__qkSmokeRoot;
      const file = source + '/upload fixture.txt';
      const options = {defaultPath: source};
      const files = await window.qk.dialog.pickFiles(options);
      check('desktop file selection round trip', files.length === 1 && files[0] === file);
      const folders = await window.qk.dialog.pickDirs(options);
      check('desktop folder selection round trip', folders.length === 1 && folders[0] === source + '/chosen');
      check('desktop download directory cancel', (await window.qk.dialog.saveDir(source)) === null);
      const confirmed = await window.qk.dialog.confirm({title:'Linux QA 确认', message:'确认测试操作'});
      check('desktop confirmation accepted', confirmed === true);

      const dropped = new Promise(resolve => {
        const unsubscribe = window.qk.dialog.onFilesDropped(paths => {
          unsubscribe();
          resolve(paths);
        });
      });
      await window.qk.dialog.showInFolder(file);
      check('desktop drag returns exact local paths', (await dropped).includes(file));

      let loginCode;
      try { await window.qk.auth.login(); } catch (error) { loginCode = error.code; }
      check('desktop login window cancellation', loginCode === 'ABORTED');
    }
  } catch(e) { checks.push({name:'exception',ok:false,code:e.code || 'JS',message:String(e.message).slice(0,180)}); }
  await window.__TAURI__.core.invoke('smoke_report', {report:{checks, passed: checks.every(c => c.ok), runtime:'Tauri 2 / system WebView / Rust', userAgent:navigator.userAgent}});
})();
