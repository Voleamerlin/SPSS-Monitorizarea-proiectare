import {test} from 'node:test';
import assert from 'node:assert/strict';
import {blankTask,delayDays,isOverdue,canEdit,csvCell,workCsv,today,readsAll,readsAdministration,managesRegistry} from '../lib/model.ts';

test('overdue uses calendar days and closes at actual completion',()=>{
 const task={...blankTask('Proiectant Demo A'),id:1,dueDate:'2026-11-20',status:'În proces'};
 assert.equal(delayDays(task,'2026-11-23'),3);
 assert.equal(isOverdue(task,'2026-11-20'),false);
 assert.equal(isOverdue(task,'2026-11-21'),true);
 assert.equal(delayDays({...task,status:'Finalizată',finishedDate:'2026-11-19'},'2027-01-01'),0);
 assert.equal(delayDays({...task,status:'Aprobată',finishedDate:'2026-11-22'},'2027-01-01'),2);
 assert.equal(isOverdue({...task,status:'Aprobată',finishedDate:'2026-11-22'}),false);
 assert.equal(delayDays({...task,dueDate:''}),0);
});
test('designers cannot modify work belonging to someone else',()=>{
 const designer={role:'designer',designer:'Proiectant Demo A'};
 assert.equal(canEdit(designer,{designer:'Proiectant Demo A'}),true);
 assert.equal(canEdit(designer,{designer:'Proiectant Demo B'}),false);
 assert.equal(canEdit({role:'designer',designer:''},{designer:''}),false);
 assert.equal(canEdit({role:'owner',designer:''},{designer:'Proiectant Demo B'}),true);
});
test('CSV protects spreadsheet formulas and preserves 30 original columns',()=>{
 for(const value of ['=SUM(A1)',' +CMD','-1+1','@SUM(A1)','\t=1','\n=1'])assert.ok(csvCell(value).startsWith('"\''));
 assert.equal(csvCell('Concept "SIIV"'),'"Concept ""SIIV"""');
 const task={...blankTask('Proiectant Demo A'),id:1,projectId:'p-001',title:'Concept',updatedAt:'2026-11-23T12:00:00Z'};
 const csv=workCsv([task],[{id:'p-001',name:'SIIV'}]);
 assert.equal(csv.slice(1).split('\r\n')[0].split(';').length,30);
 assert.ok(csv.includes('"SIIV"'));assert.ok(csv.startsWith('\uFEFF'));
});
test('date control format is ISO and timezone is Chisinau',()=>{
 assert.match(today(),/^\d{4}-\d{2}-\d{2}$/);
 assert.equal(blankTask().requestedDate,today());
});
test('Audit sees all sections but can never edit even with a matching designer',()=>{
 const audit={role:'audit',designer:'Proiectant Demo A'};
 assert.equal(readsAll(audit),true);assert.equal(readsAdministration(audit),true);
 assert.equal(managesRegistry(audit),false);assert.equal(canEdit(audit,{designer:'Proiectant Demo A'}),false);
 assert.equal(readsAll({role:'designer'}),false);assert.equal(readsAdministration({role:'owner'}),false);
});
