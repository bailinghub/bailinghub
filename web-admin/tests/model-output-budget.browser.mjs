import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const url=process.env.BUDGET_CONSOLE_URL||'http://127.0.0.1:18933/console/usage?tab=models';
const output=process.env.BUDGET_CONSOLE_EVIDENCE||'/tmp/bailing-output-budget-console';
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1080}});
page.setDefaultTimeout(10000);
const errors=[],unexpected=[],posts=[],checks=[];
page.on('pageerror',e=>errors.push(e.message));
const base={credential:'synthetic-provider',model:'synthetic-chat',providerScope:'synthetic-provider',maxInputBytes:8388608,maxOutputTokens:8192,timeoutMs:120000,
  pricing:{source:'openrouter',modelId:'synthetic-chat',endpointId:'synthetic',kind:'chat'}};
const services=[{id:'legacy',label:'原配置',revision:1,state:'active',availability:{state:'ready'},config:{...base}},
{id:'explicit',label:'独立预算',revision:1,state:'active',availability:{state:'ready'},config:{...base,maxOutputTokens:65536,defaultOutputTokens:32768,outputTokenParameter:'max_completion_tokens',outputBudgetScope:'completion_total',modelMaxOutputTokens:131072}},
{id:'image',label:'图片服务',revision:1,state:'active',availability:{state:'ready'},config:{...base,purpose:'tool',pricing:undefined,tool:{name:'generate_image',capability:'image_generation',description:'生成图片',outputs:['image'],parameters:[],adapter:'pending'}}}];
await page.route('**/branding',r=>r.fulfill({json:{}}));
await page.route('**/health',r=>r.fulfill({json:{status:'ok'}}));
await page.route('**/admin/api/**',async r=>{
  const u=new URL(r.request().url()),p=u.pathname,method=r.request().method();
  if(p==='/admin/api/me')return r.fulfill({json:{username:'synthetic',role:'admin',perms:['*']}});
  if(p==='/admin/api/status')return r.fulfill({json:{executors:[]}});
  if(p==='/admin/api/demo-dataset/status')return r.fulfill({json:{imported:false}});
  if(p==='/admin/api/credentials')return r.fulfill({json:[{name:'synthetic-provider',kind:'llm',default_model:'synthetic-chat'},{name:'other-provider',kind:'llm',default_model:'synthetic-other'}]});
  if(p==='/admin/api/usage/billing/plans')return r.fulfill({json:{items:[],billing_ready:true,period_allowance_supported:true}});
  if(p==='/admin/api/usage/accounts')return r.fulfill({json:{items:[],next_cursor:null}});
  if(p==='/admin/api/usage/services'){
    if(method==='GET')return r.fulfill({json:{items:services}});
    const b=r.request().postDataJSON();posts.push(b);
    const old=services.find(s=>s.id===b.id);assert.equal(b.expected_revision,old?.revision||0);
    const saved={id:b.id,label:b.label,revision:(old?.revision||0)+1,state:b.state,availability:{state:'ready'},config:b.config};
    if(old)Object.assign(old,saved);else services.push(saved);
    return r.fulfill({json:saved});
  }
  if(p==='/admin/api/usage/pricing/models')return r.fulfill({json:{items:[{id:'synthetic-chat',label:'Synthetic',kind:'chat'}],fetchedAt:1,stale:false}});
  if(p==='/admin/api/usage/pricing/endpoints')return r.fulfill({json:{items:[{id:'synthetic',label:'Synthetic',pricing:{source:'openrouter',currency:'USD',modelId:u.searchParams.get('model_id'),endpointId:'synthetic',fetchedAt:1,lines:[{billable:'prompt',unit:'token',costUsd:'0.000001'},{billable:'completion',unit:'token',costUsd:'0.000002'}]}}],fetchedAt:1,stale:false}});
  unexpected.push(`${method} ${p}`);return r.fulfill({status:500,json:{error:'UNEXPECTED_SYNTHETIC_API'}});
});
const drawer=()=>page.getByRole('dialog').filter({has:page.getByText('模型规格与连接设置',{exact:true})});
const open=async label=>{await page.locator('.model-card').filter({has:page.getByRole('heading',{name:label,exact:true})}).getByRole('button',{name:'配置',exact:true}).click();await drawer().waitFor();if(await drawer().locator('details').filter({has:page.getByText('模型规格与连接设置',{exact:true})}).getAttribute('open')===null)await drawer().getByText('模型规格与连接设置',{exact:true}).click();};
const field=id=>drawer().getByTestId(id).locator('input');
const save=()=>drawer().getByRole('button',{name:'保存服务',exact:true}).click();
const close=async()=>{await drawer().getByRole('button',{name:'取消',exact:true}).click();const confirm=page.getByRole('button',{name:'放弃修改',exact:true});if(await confirm.isVisible().catch(()=>false))await confirm.click();await drawer().waitFor({state:'hidden'});};
try{
  await page.goto(url);await page.getByRole('tab',{name:'模型服务',exact:true}).click();await page.getByRole('heading',{name:'原配置',exact:true}).waitFor();
  await open('原配置');assert.equal(await field('budget-max').inputValue(),'8192');assert.equal(await drawer().getByTestId('budget-default').count(),0);
  await drawer().getByPlaceholder('例如：快速、深度思考').fill('原配置改名');await save();await drawer().waitFor({state:'hidden'});
  assert.deepEqual(Object.keys(posts.at(-1).config).filter(k=>/^(defaultOutput|outputToken|outputBudget|modelMaxOutput)/.test(k)),[]);checks.push('legacy unrelated save preserves budget semantics');
  await open('独立预算');assert.equal(await field('budget-default').inputValue(),'32768');assert.equal(await field('budget-max').inputValue(),'65536');
  await field('budget-default').fill('70000');const before=posts.length;await save();await drawer().getByRole('alert').filter({hasText:'默认输出预算'}).waitFor();assert.equal(posts.length,before);checks.push('default above service ceiling blocked before API');
  await field('budget-default').fill('16384');await save();await drawer().waitFor({state:'hidden'});assert.equal(posts.at(-1).config.defaultOutputTokens,16384);assert.equal(posts.at(-1).config.maxOutputTokens,65536);checks.push('default and ceiling save independently');
  await open('独立预算');await drawer().getByRole('button',{name:'预算计算范围',exact:true}).click();await page.getByText('含思考的总输出预算可能先被推理消耗',{exact:false}).waitFor();await drawer().getByRole('button',{name:'预算计算范围',exact:true}).press('Escape');assert.ok(await drawer().isVisible());await page.getByText('含思考的总输出预算可能先被推理消耗',{exact:false}).waitFor({state:'hidden'});checks.push('scope help and Escape preserve drawer');
  await page.screenshot({path:`${output}/budget-desktop.png`,fullPage:true});
  await drawer().getByTestId('budget-parameter').click();await page.getByRole('option',{name:'max_tokens',exact:true}).click();assert.equal(await field('budget-model-max').inputValue(),'');
  await field('budget-model-max').fill('131072');await drawer().getByTestId('budget-scope').click();await page.getByRole('option',{name:'仅最终答案',exact:true}).click();assert.equal(await field('budget-model-max').inputValue(),'');checks.push('parameter and scope change clear previously verified supplier maximum');
  await drawer().getByTestId('budget-parameter').click();await page.getByRole('option',{name:'max_completion_tokens',exact:true}).click();assert.equal(await drawer().getByTestId('budget-scope').getByText('核对后选择',{exact:true}).count(),1);checks.push('total-output parameter does not silently reinterpret answer-only scope');
  const credential=drawer().locator('.el-form-item').filter({has:page.locator('.el-form-item__label').filter({hasText:/^模型凭证$/})}).locator('.el-select');
  await credential.click();await page.getByRole('option',{name:'other-provider · synthetic-other',exact:true}).click();
  assert.equal(await field('budget-model-max').inputValue(),'');
  const after=posts.length;await save();await drawer().getByRole('alert').filter({hasText:'核对供应商路由'}).waitFor();assert.equal(posts.length,after);checks.push('route change clears verified semantics and model maximum');
  await close();
  await open('图片服务');assert.equal(await drawer().getByTestId('budget-mode').count(),0);await drawer().getByPlaceholder('例如：快速、深度思考').fill('图片改名');await save();await drawer().waitFor({state:'hidden'});assert.equal(posts.at(-1).config.defaultOutputTokens,undefined);checks.push('image tool excludes chat policy');
  await page.getByRole('button',{name:'添加模型服务',exact:true}).click();await drawer().waitFor();if(await drawer().locator('details').filter({has:page.getByText('模型规格与连接设置',{exact:true})}).getAttribute('open')===null)await drawer().getByText('模型规格与连接设置',{exact:true}).click();assert.equal(await field('budget-default').inputValue(),'');assert.equal(await field('budget-max').inputValue(),'');checks.push('new service has no guessed token budget');
  await page.setViewportSize({width:390,height:844});await page.waitForFunction(()=>{const r=[...document.querySelectorAll('.usage-config-drawer')].find(e=>e.getAttribute('aria-label')==='添加模型服务')?.getBoundingClientRect();return r&&r.left>=-1&&r.right<=window.innerWidth+1&&r.width>300;});await field('budget-default').scrollIntoViewIfNeeded();await page.screenshot({path:`${output}/budget-mobile.png`,fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);checks.push('mobile has no horizontal overflow');
  assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
  await writeFile(`${output}/browser-result.json`,JSON.stringify({ok:true,checks,apiWrites:posts.length,upstreamCalls:0,errors,unexpected},null,2));
  console.log(JSON.stringify({ok:true,checks,apiWrites:posts.length,upstreamCalls:0}));
}catch(error){await page.screenshot({path:`${output}/failure.png`,fullPage:true});await writeFile(`${output}/browser-failure.json`,JSON.stringify({message:error.message,checks,errors,unexpected,drawers:await page.locator('.usage-config-drawer').evaluateAll(es=>es.map(e=>({label:e.getAttribute('aria-label'),width:e.getBoundingClientRect().width,left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right,transform:getComputedStyle(e).transform})))},null,2));throw error;}finally{await browser.close();}
