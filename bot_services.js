async function buildWithProgress(chatId, vars, isFreeTrial = false, isRestore = false, botType) {
  let name = vars.APP_NAME;
  const githubRepoUrl = botType === 'raganork' ? GITHUB_RAGANORK_REPO_URL : GITHUB_LEVANTER_REPO_URL;
  const botTypeSpecificDefaults = defaultEnvVars[botType] || {};

  let buildResult = false;
  const createMsg = await sendAnimatedMessage(chatId, 'Creating application');

  try {
    await bot.editMessageText(`${getAnimatedEmoji()} Creating application...`, { chat_id: chatId, message_id: createMsg.message_id });
    const createMsgAnimate = await animateMessage(chatId, createMsg.message_id, 'Creating application');

    // --- FIX: Preemptively change name for restore to avoid conflict, based on your request ---
    const originalName = name;
    if (isRestore) {
        let newName = originalName;
        const endsWithNumber = /-\d+$/;
        if (endsWithNumber.test(newName)) {
            const prefix = newName.replace(/-\d+$/, '');
            const newSuffix = `-${Math.floor(Math.random() * 9999).toString().padStart(4, '0')}`;
            newName = `${prefix}${newSuffix}`;
        } else {
            const newSuffix = `-${Math.floor(Math.random() * 9999).toString().padStart(4, '0')}`;
            newName = `${newName.substring(0, 30 - newSuffix.length)}${newSuffix}`;
        }

        name = newName.toLowerCase();
        vars.APP_NAME = name;
        console.log(`[Restore] App is being restored. Using new name to avoid conflict: "${name}".`);
        await bot.editMessageText(`${getAnimatedEmoji()} Restoring app with new name: "${name}"...`, { chat_id: chatId, message_id: createMsg.message_id });
    }

    await axios.post('https://api.heroku.com/apps', { name }, {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3'
      }
    });
    clearInterval(createMsgAnimate);

    await bot.editMessageText(`${getAnimatedEmoji()} Configuring resources...`, { chat_id: chatId, message_id: createMsg.message_id });
    const configMsgAnimate = await animateMessage(chatId, createMsg.message_id, 'Configuring resources');

    await axios.post(
      `https://api.heroku.com/apps/${name}/addons`,
      { plan: 'heroku-postgresql' },
      {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3',
          'Content-Type': 'application/json'
        }
      }
    );

    await axios.put(
      `https://api.heroku.com/apps/${name}/buildpack-installations`,
      {
        updates: [
          { buildpack: 'https://github.com/heroku/heroku-buildpack-apt' },
          { buildpack: 'https://github.com/jonathanong/heroku-buildpack-ffmpeg-latest' },
          { buildpack: 'heroku/nodejs' }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3',
          'Content-Type': 'application/json'
        }
      }
    );
    clearInterval(configMsgAnimate);

    await bot.editMessageText(`${getAnimatedEmoji()} Setting environment variables...`, { chat_id: chatId, message_id: createMsg.message_id });
    const varsMsgAnimate = await animateMessage(chatId, createMsg.message_id, 'Setting environment variables');

    const filteredVars = {};
    for (const key in vars) {
        if (Object.prototype.hasOwnProperty.call(vars, key) && vars[key] !== undefined && vars[key] !== null && String(vars[key]).trim() !== '') {
            filteredVars[key] = vars[key];
        }
    }

    let finalConfigVars = {};
    if (isRestore) {
        finalConfigVars = filteredVars;
    } else {
        finalConfigVars = {
            ...botTypeSpecificDefaults,
            ...filteredVars
        };
    }

    await axios.patch(
      `https://api.heroku.com/apps/${name}/config-vars`,
      {
        ...finalConfigVars,
        APP_NAME: name
      },
      {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3',
          'Content-Type': 'application/json'
        }
      }
    );
    clearInterval(varsMsgAnimate);

    await bot.editMessageText(`Starting build process...`, { chat_id: chatId, message_id: createMsg.message_id });
    const bres = await axios.post(
      `https://api.heroku.com/apps/${name}/builds`,
      { source_blob: { url: `${githubRepoUrl}/tarball/main` } },
      {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3',
          'Content-Type': 'application/json'
        }
      }
    );

    let buildStatus;

    if (botType === 'raganork') {
        console.log(`[Build] Starting simulated build for Raganork app: ${name}`);
        buildStatus = 'pending';

        await new Promise(resolve => {
            const buildDuration = 72000;
            const updateInterval = 1500;
            let elapsedTime = 0;

            const simulationInterval = setInterval(async () => {
                elapsedTime += updateInterval;
                const percentage = Math.min(100, Math.floor((elapsedTime / buildDuration) * 100));
                try {
                    await bot.editMessageText(`Building... ${percentage}%`, {
                        chat_id: chatId,
                        message_id: createMsg.message_id
                    });
                } catch (e) {
                    if (!e.message.includes('message is not modified')) {
                        console.error("Error editing message during build simulation:", e.message);
                    }
                }
                if (elapsedTime >= buildDuration) {
                    clearInterval(simulationInterval);
                    buildStatus = 'succeeded';
                    resolve();
                }
            }, updateInterval);
        });

    } else {
        const statusUrl = `https://api.heroku.com/apps/${name}/builds/${bres.data.id}`;
        buildStatus = 'pending';
        let currentPct = 0;

        const buildProgressInterval = setInterval(async () => {
            try {
                const poll = await axios.get(statusUrl, {
                    headers: {
                        Authorization: `Bearer ${HEROKU_API_KEY}`,
                        Accept: 'application/vnd.heroku+json; version=3'
                    }
                });
                buildStatus = poll.data.status;
                if (buildStatus === 'pending') {
                    currentPct = Math.min(99, currentPct + Math.floor(Math.random() * 5) + 1);
                } else if (buildStatus === 'succeeded') {
                    currentPct = 100;
                } else if (buildStatus === 'failed') {
                    currentPct = 'Error';
                }
                await bot.editMessageText(`Building... ${currentPct}%`, {
                    chat_id: chatId,
                    message_id: createMsg.message_id
                }).catch(() => {});
                if (buildStatus !== 'pending' || currentPct === 100 || currentPct === 'Error') {
                    clearInterval(buildProgressInterval);
                }
            } catch (error) {
                console.error(`Error polling build status for ${name}:`, error.message);
                clearInterval(buildProgressInterval);
                await bot.editMessageText(`Building... Error`, {
                    chat_id: chatId,
                    message_id: createMsg.message_id
                }).catch(() => {});
                buildStatus = 'error';
            }
        }, 5000);

        try {
            const BUILD_COMPLETION_TIMEOUT = 300 * 1000;
            let completionTimeoutId = setTimeout(() => {
                clearInterval(buildProgressInterval);
                buildStatus = 'timed out';
                throw new Error(`Build process timed out after ${BUILD_COMPLETION_TIMEOUT / 1000} seconds.`);
            }, BUILD_COMPLETION_TIMEOUT);
            while (buildStatus === 'pending') {
                await new Promise(r => setTimeout(r, 5000));
            }
            clearTimeout(completionTimeoutId);
            clearInterval(buildProgressInterval);
        } catch (err) {
            clearInterval(buildProgressInterval);
            await bot.editMessageText(`Build process for "${name}" timed out. Check Heroku logs.`, {
                chat_id: chatId,
                message_id: createMsg.message_id
            });
            buildResult = false;
            return buildResult;
        }
    }

    if (buildStatus === 'succeeded') {
      console.log(`[Flow] buildWithProgress: Heroku build for "${name}" SUCCEEDED.`);

      let expirationDateToUse;
      // --- FIX: Check if this is a restore that required a name change ---
      if (isRestore && name !== originalName) {
        try {
            const originalDeployment = (await pool.query('SELECT expiration_date FROM user_deployments WHERE user_id = $1 AND app_name = $2', [chatId, originalName])).rows[0];
            if (originalDeployment) {
              expirationDateToUse = originalDeployment.expiration_date;
              await pool.query('DELETE FROM user_deployments WHERE user_id = $1 AND app_name = $2', [chatId, originalName]);
              console.log(`[Expiration Fix] Transferred expiration date from original deployment (${originalName}) to new deployment (${name}).`);
            }
            // Fix: Update the user_bots table to rename the bot
            await pool.query('UPDATE user_bots SET bot_name = $1, session_id = $2, bot_type = $3 WHERE user_id = $4 AND bot_name = $5', [name, vars.SESSION_ID, botType, chatId, originalName]);
            console.log(`[DB Rename Fix] Renamed bot in user_bots table from "${originalName}" to "${name}".`);
        } catch (dbError) {
            console.error(`[Expiration Fix] Error fetching/deleting original deployment record for ${originalName}:`, dbError.message);
        }
      } else {
        // This is a new deployment or a redeploy without a name change
        await addUserBot(chatId, name, vars.SESSION_ID, botType);
      }
      
      const herokuConfigVars = (await axios.get(`https://api.heroku.com/apps/${name}/config-vars`, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } })).data;
      
      await saveUserDeployment(chatId, name, vars.SESSION_ID, herokuConfigVars, botType, isFreeTrial, expirationDateToUse);
      
      if (isFreeTrial) {
        await recordFreeTrialDeploy(chatId);
      }
      
      // --- REWARD LOGIC START ---
      try {
          const userBotCount = await getUserBotCount(chatId);
          const userHasReceivedReward = await hasReceivedReward(chatId);

          if (userBotCount >= 10 && !userHasReceivedReward) {
              const newKey = generateKey();
              await addDeployKey(newKey, 1, 'AUTOMATIC_REWARD', chatId);
              await recordReward(chatId);

              const rewardMessage = `Congratulations! You have deployed 10 or more bots with our service. As a token of our appreciation, here is a free one-time deploy key:\n\n\`${newKey}\``;
              await bot.sendMessage(chatId, rewardMessage, { parse_mode: 'Markdown' });

              await bot.sendMessage(ADMIN_ID, `Reward issued to user \`${chatId}\` for reaching 10 deployments. Key: \`${newKey}\``, { parse_mode: 'Markdown' });
              console.log(`[Reward] Issued free key to user ${chatId}.`);
          }
      } catch (rewardError) {
          console.error(`[Reward] Failed to check or issue reward to user ${chatId}:`, rewardError.message);
      }
      // --- REWARD LOGIC END ---

      const { first_name, last_name, username } = (await bot.getChat(chatId)).from || {};
      const userDetails = [`*Name:* ${escapeMarkdown(first_name || '')} ${escapeMarkdown(last_name || '')}`, `*Username:* @${escapeMarkdown(username || 'N/A')}`, `*Chat ID:* \`${escapeMarkdown(chatId)}\``].join('\n');
      const appDetails = `*App Name:* \`${escapeMarkdown(name)}\`\n*Session ID:* \`${escapeMarkdown(vars.SESSION_ID)}\`\n*Type:* ${isFreeTrial ? 'Free Trial' : 'Permanent'}`;
      await bot.sendMessage(ADMIN_ID, `*New App Deployed*\n\n*App Details:*\n${appDetails}\n\n*Deployed By:*\n${userDetails}`, { parse_mode: 'Markdown', disable_web_page_preview: true });
      const baseWaitingText = `Build successful! Waiting for bot to connect...`;
      await bot.editMessageText(`${getAnimatedEmoji()} ${baseWaitingText}`, { chat_id: chatId, message_id: createMsg.message_id, parse_mode: 'Markdown' });
      const animateIntervalId = await animateMessage(chatId, createMsg.message_id, baseWaitingText);
      const appStatusPromise = new Promise((resolve, reject) => {
          const STATUS_CHECK_TIMEOUT = 120 * 1000;
          const timeoutId = setTimeout(() => {
              const appPromise = appDeploymentPromises.get(name);
              if (appPromise) {
                  appPromise.reject(new Error(`Bot did not connect within ${STATUS_CHECK_TIMEOUT / 1000} seconds.`));
                  appDeploymentPromises.delete(name);
              }
          }, STATUS_CHECK_TIMEOUT);
          appDeploymentPromises.set(name, { resolve, reject, animateIntervalId, timeoutId });
      });


      try {
          await appStatusPromise;
          const promiseData = appDeploymentPromises.get(name);
          if (promiseData && promiseData.timeoutId) {
             clearTimeout(promiseData.timeoutId);
          }
          clearInterval(animateIntervalId);

          await bot.editMessageText(
              `Your bot *${escapeMarkdown(name)}* is now live!\n\nBackup your app for future reference.`,
              {
                  chat_id: chatId,
                  message_id: createMsg.message_id,
                  parse_mode: 'Markdown',
                  reply_markup: {
                      inline_keyboard: [[{ text: `Backup "${name}"`, callback_data: `backup_app:${name}` }]]
                  }
              }
          );
          buildResult = true;

          if (isFreeTrial) {
            await recordFreeTrialForMonitoring(chatId, name, TELEGRAM_CHANNEL_ID);
            const THREE_DAYS_IN_MS = 3 * 24 * 60 * 60 * 1000;
            const ONE_HOUR_IN_MS = 1 * 60 * 60 * 1000;
            
            setTimeout(async () => {
                const adminWarningMessage = `Free Trial App "*${escapeMarkdown(name)}*" has 1 hour left until deletion!`;
                const keyboard = { inline_keyboard: [[{ text: `Delete "*${escapeMarkdown(name)}" Now`, callback_data: `admin_delete_trial_app:${name}` }]] };
                await bot.sendMessage(ADMIN_ID, adminWarningMessage, { reply_markup: keyboard, parse_mode: 'Markdown' });
                console.log(`[FreeTrial] Sent 1-hour warning to admin for ${name}.`);
            }, THREE_DAYS_IN_MS - ONE_HOUR_IN_MS);

            setTimeout(async () => {
                try {
                    await bot.sendMessage(chatId, `Your Free Trial app "*${escapeMarkdown(name)}*" is being deleted as its 3-day runtime has ended.`);
                    await axios.delete(`https://api.heroku.com/apps/${name}`, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } });
                    await deleteUserBot(chatId, name);
                    await markDeploymentDeletedFromHeroku(chatId, name);
                    await bot.sendMessage(chatId, `Free Trial app "*${escapeMarkdown(name)}*" successfully deleted.`);
                    console.log(`[FreeTrial] Auto-deleted app ${name} after 3 days.`);
                } catch (e) {
                    console.error(`Failed to auto-delete free trial app ${name}:`, e.message);
                    await bot.sendMessage(chatId, `Could not auto-delete "*${escapeMarkdown(name)}*". Please delete it from your Heroku dashboard.`, {parse_mode: 'Markdown'});
                    monitorSendTelegramAlert(`Failed to auto-delete free trial app "*${escapeMarkdown(name)}*" for user ${escapeMarkdown(chatId)}: ${escapeMarkdown(e.message)}`, ADMIN_ID);
                }
            }, THREE_DAYS_IN_MS);
          }
      } catch (err) {
          const promiseData = appDeploymentPromises.get(name);
          if (promiseData) {
             clearInterval(promiseData.animateIntervalId);
             if (promiseData.timeoutId) clearTimeout(promiseData.timeoutId);
          }
          console.error(`App status check failed for ${name}:`, err.message);
          await bot.editMessageText(
            `Bot "*${escapeMarkdown(name)}*" failed to start: ${escapeMarkdown(err.message)}\n\nYou may need to update the session ID.`,
            {
                chat_id: chatId,
                message_id: createMsg.message_id,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: 'Change Session ID', callback_data: `change_session:${name}:${chatId}` }]]
                }
            }
          );
          buildResult = false;
      } finally {
          appDeploymentPromises.delete(name);
      }
    } else {
      await bot.editMessageText(`Build status: ${buildStatus}. Contact Admin for support.`, { chat_id: chatId, message_id: createMsg.message_id, parse_mode: 'Markdown' });
      buildResult = false;
    }
  } catch (error) {
    const errorMsg = error.response?.data?.message || error.message;
    bot.sendMessage(chatId, `An error occurred: ${escapeMarkdown(errorMsg)}\n\Contact Adminfor support.`, {parse_mode: 'Markdown'});
    buildResult = false;
  }
  return buildResult;
}
