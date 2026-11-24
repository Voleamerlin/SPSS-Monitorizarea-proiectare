import {Storage} from "./storage.js";
import {readFileSync} from "node:fs";
const tokenFile=process.env.SPSS_MAIL_API_TOKEN_FILE;
export const env={DB:new Storage(process.env.SPSS_DB_PATH||"./var/spss.sqlite"),SPSS_MAIL_API_TOKEN:tokenFile?readFileSync(tokenFile,"utf8").trim():process.env.SPSS_MAIL_API_TOKEN||""};
