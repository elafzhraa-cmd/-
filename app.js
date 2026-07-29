const P=[
{id:1,c:'yogurt',n:'Greek Yogurt 200غ',d:'قوام كريمي، 9غ بروتين لكل 100غ.',p:2750,t:'الأكثر طلباً'},
{id:2,c:'yogurt',n:'Greek Yogurt 600غ',d:'حجم عائلي وعملي للوصفات اليومية.',p:7000,t:'حجم عائلي'},
{id:3,c:'yogurt',n:'Icelandic 200غ',d:'قوام أكثر كثافة، 12غ بروتين لكل 100غ.',p:3250,t:'بروتين أعلى'},
{id:4,c:'yogurt',n:'Icelandic 600غ',d:'تركيز أعلى لمحبي الوجبات عالية البروتين.',p:8500,t:'12غ بروتين'},
{id:5,c:'granola',n:'GREKO Granola',d:'شوفان ومكسرات بطعم متوازن وقرمشة واضحة.',p:4500,t:'جديد'},
{id:6,c:'sauce',n:'Yogurt Sauce 200غ',d:'صوص زبادي خفيف للسلطات والسندويشات.',p:3000,t:'متعدد الاستخدام'}];
let C=JSON.parse(localStorage.getItem('grekoCart')||'{}');
const $=s=>document.querySelector(s),money=n=>new Intl.NumberFormat('ar-IQ').format(n)+' د.ع';
function render(cat='all'){$('#grid').innerHTML=P.filter(x=>cat==='all'||x.c===cat).map(x=>`<article class="card"><div class="art"><span class="tag">${x.t}</span><div class="mini">GREKO</div></div><h3>${x.n}</h3><p>${x.d}</p><div class="price"><b>${money(x.p)}</b><button onclick="add(${x.id})">+</button></div></article>`).join('')}
function filterP(c,e){document.querySelectorAll('.chips button').forEach(x=>x.classList.remove('active'));e.classList.add('active');render(c)}
function add(id){C[id]=(C[id]||0)+1;save();toast('تمت الإضافة للسلة')}
function change(id,d){C[id]=(C[id]||0)+d;if(C[id]<=0)delete C[id];save();cart()}
function save(){localStorage.setItem('grekoCart',JSON.stringify(C));$('#count').textContent=Object.values(C).reduce((a,b)=>a+b,0)}
function cart(){let total=0,rows=Object.entries(C).map(([id,q])=>{let x=P.find(y=>y.id==id);total+=x.p*q;return `<div class="item"><div><b>${x.n}</b><br>${money(x.p*q)}</div><div class="qty"><button onclick="change(${id},-1)">−</button> <b>${q}</b> <button onclick="change(${id},1)">+</button></div></div>`});$('#items').innerHTML=rows.length?rows.join(''):'<p>السلة فارغة حالياً</p>';$('#total').textContent=money(total)}
function openCart(){cart();$('#drawer').classList.add('open')}function closeCart(){$('#drawer').classList.remove('open')}
async function copyOrder(){let lines=Object.entries(C).map(([id,q])=>`• ${P.find(x=>x.id==id).n} × ${q}`);if(!lines.length)return toast('أضف منتجاً أولاً');let total=Object.entries(C).reduce((s,[id,q])=>s+P.find(x=>x.id==id).p*q,0),text=`مرحباً GREKO، أريد الطلب التالي:\n${lines.join('\n')}\nالمجموع: ${money(total)}\nالاسم:\nالمنطقة:\nرقم الهاتف:`;try{await navigator.clipboard.writeText(text);toast('تم نسخ الطلب')}catch(e){toast('صوّر السلة وأرسلها')}setTimeout(()=>window.open('https://www.instagram.com/greko.iq/','_blank'),500)}
function calc(){$('#protein').textContent=Math.round((+$('#weight').value||0)*(+$('#goal').value))}
function toast(m){let t=$('#toast');t.textContent=m;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2200)}
render();save();calc();