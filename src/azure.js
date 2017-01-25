const readline = require('readline');
const exec = require('child_process').exec;
const msRestAzure = require('ms-rest-azure');
const resourceManagement = require('azure-arm-resource');
const webSiteManagement = require('azure-arm-website');
const configManagement = require('./config');
const util = require('./apputil');

module.exports.publish = () => {
  let outputCached;
  let authCached;
  return promptForPublishParameters()
    .then(output => {
      outputCached = output;
      return auth(output.tenantId);
    })
    .then(auth => {
      authCached = auth;
      return createResourceGroup(auth, outputCached);
    })
    .then(() => createWebApp(authCached, outputCached))
    .then(() => enableGitPushDeploy(authCached, outputCached))
    .then(() => fixGitRemotes(outputCached.name))
    .then(() => displayGitCredentialsMessage())
    .catch(err => console.log(`Azure publishing error: ${err.message}`));
};

function getTenantIdFromConfig() {
  return configManagement.loadConfig()
    .then(config => config.tenantId)
    .catch(() => '');
}

function saveTenantIdToConfig(tenantId) {
  return configManagement.loadConfig()
    .then(config => Object.assign(config, { tenantId }))
    .then(config => configManagement.saveConfig(config));
}

function auth(tenantId) {
  return new Promise((resolve, reject) => {
    msRestAzure.interactiveLogin({ domain: tenantId }, (err, credentials, subscriptions) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({ credentials, subscriptions });
    });
  });
}

function displayGitCredentialsMessage() {
  util.displayAction('First time with local git deployment to Azure App Service?');
  util.displayAction(' 1. In your browser, navigate to https://portal.azure.com');
  util.displayAction(' 2. Find your web app resource group and navigate to it');
  util.displayAction(' 3. Click on the App Service in your resource group');
  util.displayAction(' 4. Navigate to the `Deployment credentials` section');
  util.displayAction(' 5. Add/change your git deployment credentials and save');
}

function fixGitRemotes(webAppName) {
  return new Promise((resolve, reject) => {
    exec('git remote remove origin', err => {
      if (err) {
        reject(err);
        return;
      }
      exec(`git remote add azure https://${webAppName}.scm.azurewebsites.net:443/${webAppName}.git`, err => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  });
}

function enableGitPushDeploy(auth, options) {
  return new Promise((resolve, reject) => {
    const client = new webSiteManagement(auth.credentials, auth.subscriptions[0].id);
    client.sites.updateSiteConfig(
      options.name,
      options.name,
      {
        scmType: 'LocalGit',
        location: options.location,
        remoteDebuggingEnabled: true
      },
      (err, result) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(result);
      }
    );
  });
}

function createWebApp(auth, options) {
  return new Promise((resolve, reject) => {
    const client = new webSiteManagement(auth.credentials, auth.subscriptions[0].id);
    client.sites.createOrUpdateSite(
      options.name,
      options.name,
      {
        siteName: options.name,
        location: options.location
      },
      (err, result) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(result);
      }
    );
  });
}

function createResourceGroup(auth, options) {
  return new Promise((resolve, reject) => {
    const client = new resourceManagement.ResourceManagementClient(auth.credentials, auth.subscriptions[0].id);
    client.resourceGroups.createOrUpdate(
      // currently we will name the resource group the same name as the web app
      options.name,
      { location: options.location },
      (err, result) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(result);
      }
    );
  });
}

function promptForPublishParameters() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  let parentTenantId;
  let parentLocation;

  return getTenantIdFromConfig()
    .then(tenantId =>
      new Promise(resolve => {
        rl.question(`(optional) Tenant ID [default: ${tenantId ? tenantId : 'none'}]: `, inputTenantId => {
          if (inputTenantId) {
            // user inputed a tenant id, so this is now the tenantId and we should cache it
            parentTenantId = inputTenantId;
            resolve(inputTenantId);
          }
          else if (!inputTenantId && tenantId) {
            // user did not input a tenant id and an actual one was cached
            parentTenantId = tenantId;
            resolve(tenantId);
          }
          else {
            // no inputed tenant id and no cached one
            parentTenantId = '';
            resolve();
          }
        });
      })
    )
    .then(tenantId => {
      if (tenantId) {
        saveTenantIdToConfig(tenantId);
      }
    })
    .then(() => new Promise(resolve => {
      rl.question('Location (found by running `nerd regions`): ', location => {
        parentLocation = location;
        resolve();
      });
    }))
    .then(() => new Promise(resolve => {
      rl.question('Web app name: ', name => {
        rl.close();
        resolve({ tenantId: parentTenantId, name, location: parentLocation });
      });
    }));
}

module.exports.listRegions = () => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  let parentTenantId;

  return getTenantIdFromConfig()
    .then(tenantId =>
      new Promise(resolve => {
        rl.question(`(optional) Tenant ID [default: ${tenantId ? tenantId : 'none'}]: `, inputTenantId => {
          if (inputTenantId) {
            // user inputed a tenant id, so this is now the tenantId and we should cache it
            parentTenantId = inputTenantId;
            resolve(inputTenantId);
          }
          else if (!inputTenantId && tenantId) {
            // user did not input a tenant id and an actual one was cached
            parentTenantId = tenantId;
            resolve(tenantId);
          }
          else {
            // no inputed tenant id and no cached one
            parentTenantId = '';
            resolve();
          }
        });
      })
    )
    .then(tenantId => {
      if (tenantId) {
        saveTenantIdToConfig(tenantId);
      }
    })
    .then(() => new Promise((resolve, reject) => {
      msRestAzure.interactiveLogin({ domain: parentTenantId }, (err, creds, subs) => {
        if (!subs || subs.length === 0) {
          reject(Error('Unable to retrieve subscriptions'));
          rl.close();
          return;
        }
        const client = new resourceManagement.SubscriptionClient(creds);
        client.subscriptions.listLocations(subs[0].id, (err, result) => {
          if (err) {
            rl.close();
            reject(err);
            return;
          }
          result.forEach(region => {
            console.log(`${region.displayName} (${region.name})`);
          });
          rl.close();
          resolve();
        });
      });
    }));
};
