import * as winston from "winston"
import * as Hub from "../../hub"
import { Queue } from "./queue"

const MARKETO: any = require("node-marketo-rest")

const numLeadsAllowedPerCall = 100

interface Result {
  leads: any[],
  skipped: any[],
  leadErrors: any[],
  membershipErrors: any[],
}

export class MarketoTransaction {

  fieldMap: any
  marketo: any
  campaignIds: string[] = []
  addListIds: string[] = []
  removeListIds: string[] = []
  lookupField?: string

  async handleRequest(request: Hub.ActionRequest): Promise<Hub.ActionResponse> {

    this.campaignIds = (
		request.formParams.campaignIds
		|| request.formParams.campaignId //Support the old "single add" format as well
		|| '').split(/\s*,\s*/).filter(Boolean)
	this.addListIds = (request.formParams.addListIds || '').split(/\s*,\s*/).filter(Boolean)
	this.removeListIds = (request.formParams.removeListIds || '').split(/\s*,\s*/).filter(Boolean)
    this.lookupField = request.formParams.lookupField
    if (!this.lookupField) {
      throw "Missing Lookup Field."
    }

    this.marketo = this.marketoClientFromRequest(request)

    const queue = new Queue()

    let rows: Hub.JsonDetail.Row[] = []

    const sendChunk = () => {
      const chunk = rows.slice(0)
      const task = async () => this.processChunk(chunk)
      rows = []
      queue.addTask(task)
    }

    await request.streamJsonDetail({
      onFields: (fields) => {
        this.fieldMap = this.getFieldMap(Hub.allFields(fields))

        // determine if lookupField is present in fields
        if (! Object.keys(this.fieldMap).find((name) => this.fieldMap[name].indexOf(this.lookupField) !== -1)) {
          throw "Marketo Lookup Field for lead not present in query."
        }
      },
      onRow: (row) => {
        // add the row to our row queue
        rows.push(row)
        if (rows.length === numLeadsAllowedPerCall) {
          sendChunk()
        }
      },
    })

    // we awaited streamJsonDetail, so we've got all our rows now

    // if any rows are left, send one more chunk
    if (rows.length > 0) {
      sendChunk()
    }

    // tell the queue we're finished adding rows and await the results
    const completed = await queue.finish()

    // filter all the successful results
    const results = (
      completed
      .filter((task: any) => task.result)
      .map((task: any) => task.result)
    )

    // filter all the request errors
    const errors = (
      completed
      .filter((task: any) => task.error)
      .map((task: any) => task.error)
    )

    // concatenate results and errors into a single result
    const result: any = {
      leads: results.reduce((memo: any[], r: Result) => memo.concat(r.leads), []),
      skipped: results.reduce((memo: any[], r: Result) => memo.concat(r.skipped), []),
      leadErrors: results.reduce((memo: any[], r: Result) => memo.concat(r.leadErrors), []),
      membershipErrors: results.reduce((memo: any[], r: Result) => memo.concat(r.membershipErrors), []),
      requestErrors: errors,
    }

    winston.debug(JSON.stringify(result, null, 2))

    if (this.hasErrors(result)) {
      const message = this.getErrorMessage(result)
      return new Hub.ActionResponse({
        success: false,
        message,
      })
    }

    return new Hub.ActionResponse({ success: true })
  }

  async processChunk(chunk: any[]) {
    const result: Result = {
      leads: this.getLeadList(chunk),
      skipped: [],
      leadErrors: [],
      membershipErrors: [],
    }

    const leadResponse = await this.marketo.lead.createOrUpdate(result.leads, { lookupField: this.lookupField })
    if (Array.isArray(leadResponse.errors) && leadResponse.errors.length) {
      result.leadErrors = leadResponse.errors
    }

    const ids: any[] = []
    leadResponse.result.forEach((lead: any, i: number) => {
      if (lead.id) {
        ids.push({id: lead.id})
      } else {
        result.leads[i].result = lead
        result.skipped.push(result.leads[i])
      }
    })

    for (let campaignId of this.campaignIds){
      const response = await this.marketo.campaign.request(campaignId, ids)
      result.membershipErrors = result.membershipErrors.concat(response.errors || [])
    }
	
    for (let listId of this.addListIds){
      const response = await this.marketo.list.addLeadsToList(listId, ids)
      result.membershipErrors = result.membershipErrors.concat(response.errors || [])
    }

    for (let listId of this.removeListIds){
      const response = await this.marketo.campaign.removeLeadsFromList(listId, ids)
      result.membershipErrors = result.membershipErrors.concat(response.errors || [])
    }

    return result
  }

  marketoClientFromRequest(request: Hub.ActionRequest) {
    return new MARKETO({
      endpoint: `${request.params.url}/rest`,
      identity: `${request.params.url}/identity`,
      clientId: request.params.clientID,
      clientSecret: request.params.clientSecret,
    })
  }

  private getFieldMap(fields: Hub.Field[]) {
    // Map the looker columns to the Marketo columns using tags
    const fieldMap: {[name: string]: string[]} = {}
    let hasTagMap: string[] = []
    for (const field of fields) {
      if (field.tags && field.tags.find((tag: string) => tag.startsWith("marketo:"))) {
        hasTagMap = field.tags.filter((tag) => tag.startsWith("marketo:"))
          .map((tag) => tag.split("marketo:")[1])
        fieldMap[field.name] = hasTagMap
      }
    }
    return fieldMap
  }

  private getLeadList(rows: Hub.JsonDetail.Row[]) {
    // Create the list of leads to be sent
    const leadList: {[name: string]: any}[] = []
    for (const leadRow of rows) {
      const singleLead: {[name: string]: any} = {}
      for (const field of Object.keys(this.fieldMap)) {
        for (const tag of this.fieldMap[field]) {
          singleLead[tag] = leadRow[field].value
        }
      }
      leadList.push(singleLead)
    }
    return leadList
  }

  private hasErrors(result: any) {
    return (
      result.skipped.length
      || result.leadErrors.length
      || result.membershipErrors.length
      || result.requestErrors.length
    )
  }

  private getErrorMessage(result: any) {
    const condensed: any = {}
    if (result.skipped.length) {
      condensed.skipped = this.getSkippedReasons(result.skipped)
    }
    if (result.leadErrors.length) {
      condensed.leadErrors = result.leadErrors
    }
    if (result.membershipErrors.length) {
      condensed.membershipErrors = result.membershipErrors
    }
    if (result.requestErrors.length) {
      condensed.requestErrors = result.requestErrors
    }
    return JSON.stringify(condensed)
  }

  private getSkippedReasons(skipped: any[]) {
    const reasons: any = {}

    skipped.forEach((item: any) => {
      // get the reason item was skipped
      const reason = item.result.reasons[0].message

      // create the list of reasons if this is the first one
      if (! reasons[reason]) {
        reasons[reason] = []
      }

      // add the email to the list
      reasons[reason].push(item.email)
    })

    return reasons
  }

}