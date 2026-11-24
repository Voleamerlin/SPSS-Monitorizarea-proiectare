export const statuses = ["Nouă", "În proces", "În coordonare", "Returnată", "Suspendată", "Finalizată", "Aprobată"] as const;
export const priorities = ["Critică", "Înaltă", "Medie", "Scăzută"] as const;
export const documentTypes = ["Sarcină tehnică (ST)", "Amendament la ST", "Ghid de utilizare", "Concept", "Specificație", "Prototip UI/UX", "Diagramă/Model", "Altul"];
export const stages = ["Proiectant", "Șef SPSS", "Manager de proiect", "Coordonator tehnic", "Coordonator operațional", "Beneficiar", "Aprobat"];
export const beneficiaries = ["Beneficiar Demo A", "Beneficiar Demo B", "Altul"];
export type TaskData = {
  title: string; projectId: string; designer: string; manager: string; beneficiary: string;
  module: string; subactivity: string; documentType: string; revision: string;
  priority: typeof priorities[number]; requestedDate: string; startDate: string; dueDate: string;
  finishedDate: string; progress: number; status: typeof statuses[number]; stage: string;
  sentDate: string; returnedDate: string; returnCount: number; returnReason: string;
  resentDate: string; approvedDate: string; blockers: string; nextStep: string; notes: string; documentUrl: string;
};
export type Task = TaskData & {id: number; version: number; createdAt: string; updatedAt: string};
export type Project = {id: string; name: string; designer: string; manager: string; status: "Activ" | "Inactiv"; version: number; archivedAt:string|null;archivedBy:string|null;archiveReason:string;createdAt:string|null;updatedAt:string|null};
export type ProjectHistory = {id:string;projectId:string;actor:string;action:string;before:Project|null;after:Project;createdAt:string};
export type Member = {email: string; designer: string; enabled: number; userId?: string};
export type PersonRole = "designer" | "manager";
export type Audit = {id: string; taskId: number | null; actor: string; action: string; createdAt: string};
export type Identity = {role: "admin" | "owner" | "designer" | "audit"; userId: string; name: string; email: string; designer: string; authMethod?: string};
export type State = {projects: Project[]; tasks: Task[]; members: Member[]; designers: string[]; managers: string[]; audit: Audit[]; identity: Identity; config: import("./config.js").AppConfig};
export function managesRegistry(i: Pick<Identity,"role">) { return i.role === "admin" || i.role === "owner"; }
export function readsAll(i:Pick<Identity,"role">) {return managesRegistry(i)||i.role==="audit";}
export function readsAdministration(i:Pick<Identity,"role">) {return i.role==="admin"||i.role==="audit";}
export function today() {
  return new Intl.DateTimeFormat("en-CA", {timeZone: "Europe/Chisinau", year: "numeric", month: "2-digit", day: "2-digit"}).format(new Date());
}
export function isClosed(t: Pick<TaskData, "status">) { return t.status === "Finalizată" || t.status === "Aprobată"; }
export function delayDays(t: Pick<TaskData,"dueDate" | "finishedDate" | "approvedDate" | "status">, on = today()) {
  if (!t.dueDate) return 0;
  const end = isClosed(t) ? (t.finishedDate || t.approvedDate) : on;
  if (!end) return 0;
  return Math.max(0, Math.floor((Date.parse(end+"T00:00:00Z") - Date.parse(t.dueDate+"T00:00:00Z")) / 86400000));
}
export function isOverdue(t: Task, on = today()) { return !isClosed(t) && delayDays(t, on) > 0; }
export function canEdit(identity: Pick<Identity,"role"|"designer">, task: Pick<TaskData,"designer">) {
  return managesRegistry(identity) || (identity.role === "designer" && !!identity.designer && identity.designer === task.designer);
}
export function workCode(id: number) { return `LP-${String(id).padStart(4,"0")}`; }
export function blankTask(designer = ""): TaskData {
  return {title:"",projectId:"",designer,manager:"",beneficiary:"",module:"",subactivity:"",documentType:"Sarcină tehnică (ST)",revision:"1.0",priority:"Medie",requestedDate:today(),startDate:"",dueDate:"",finishedDate:"",progress:0,status:"Nouă",stage:"Proiectant",sentDate:"",returnedDate:"",returnCount:0,returnReason:"",resentDate:"",approvedDate:"",blockers:"",nextStep:"",notes:"",documentUrl:""};
}
export function csvCell(value: unknown) {
  let s = String(value ?? "");
  if (/^[\s]*[=+\-@]/.test(s) || /^[\t\r\n]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"','""') + '"';
}
export function workCsv(tasks: Task[], projects: Project[]) {
  const header = ["ID lucrare","Proiectant","Manager de proiect","Beneficiar","Sistem/Proiect","Modul/Subsistem","Subactivitate","Tip document","Denumirea livrabilului","Nr./versiune","Prioritate","Data solicitării","Data începerii","Termen planificat","Data finalizării","Progres","Statutul lucrării","Etapa de coordonare","Data transmiterii","Data returnării","Nr. returnări","Motivul returnării","Data retransmiterii","Data aprobării","Zile întârziere","Blocaje/Dependențe","Ultima actualizare","Următorul pas","Observații","Link document"];
  const rows = tasks.map(t=>[workCode(t.id),t.designer,t.manager,t.beneficiary,projects.find(p=>p.id===t.projectId)?.name,t.module,t.subactivity,t.documentType,t.title,t.revision,t.priority,t.requestedDate,t.startDate,t.dueDate,t.finishedDate,`${t.progress}%`,t.status,t.stage,t.sentDate,t.returnedDate,t.returnCount,t.returnReason,t.resentDate,t.approvedDate,delayDays(t),t.blockers,t.updatedAt,t.nextStep,t.notes,t.documentUrl]);
  return "\uFEFF" + [header,...rows].map(row=>row.map(csvCell).join(";")).join("\r\n");
}
