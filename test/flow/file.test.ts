import { join } from 'node:path';
import { expect } from 'chai';
import {
  apiNameOfFlowFile,
  assertFlowXml,
  FlowFileError,
  flowPaths,
  getDataSpace,
  getStartObject,
  getStartSegment,
  getStatus,
  listContentIds,
  parseSidecar,
  replaceContentIds,
  serializeSidecar,
  setDataSpace,
  setStartObject,
  setStartSegment,
  setStatus,
  sidecarPathOf,
} from '../../src/flow/file.js';
import { FLOW_XML, SEGMENT_ID } from './support.js';

/** The file with one exact piece of text exchanged; fails when the text is not there exactly once. */
function exchanged(xml: string, before: string, after: string): string {
  expect(xml.split(before)).to.have.length(2);
  return xml.replace(before, after);
}

describe('flow file', () => {
  it('reads data space, segment, object and status', () => {
    expect(getDataSpace(FLOW_XML)).to.equal('default');
    expect(getStartSegment(FLOW_XML)).to.equal(SEGMENT_ID);
    expect(getStartObject(FLOW_XML)).to.equal('UnifiedssotIndividualMkt__dlm');
    expect(getStatus(FLOW_XML)).to.equal('InvalidDraft');
  });

  it('changes one value and keeps every other byte', () => {
    expect(setDataSpace(FLOW_XML, 'dataspace2')).to.equal(
      exchanged(FLOW_XML, '    <dataSpace>default</dataSpace>', '    <dataSpace>dataspace2</dataSpace>')
    );
    expect(setStartSegment(FLOW_XML, 'My_Segment')).to.equal(exchanged(FLOW_XML, SEGMENT_ID, 'My_Segment'));
    expect(setStartObject(FLOW_XML, 'ds2_UnifiedIndividualMkt__dlm')).to.equal(
      exchanged(FLOW_XML, 'UnifiedssotIndividualMkt__dlm', 'ds2_UnifiedIndividualMkt__dlm')
    );
    expect(setStatus(FLOW_XML, 'Draft')).to.equal(
      exchanged(FLOW_XML, '<status>InvalidDraft</status>', '<status>Draft</status>')
    );
  });

  it('keeps CRLF line endings and a byte order mark outside the changed value', () => {
    const crlf = `${String.fromCharCode(0xfe_ff)}${FLOW_XML.replaceAll('\n', '\r\n')}`;
    const changed = setStartSegment(setDataSpace(crlf, 'dataspace2'), 'Other');
    expect(changed).to.equal(
      crlf.replace('<dataSpace>default<', '<dataSpace>dataspace2<').replace(SEGMENT_ID, 'Other')
    );
    expect(setStartSegment(setDataSpace(changed, 'default'), SEGMENT_ID)).to.equal(crlf);
  });

  it('escapes a written value and unescapes a read one', () => {
    const changed = setStartSegment(FLOW_XML, 'A&B<C');
    expect(changed).to.include('<segment>A&amp;B&lt;C</segment>');
    expect(getStartSegment(changed)).to.equal('A&B<C');
  });

  it('refuses to change an element the file does not have', () => {
    const without = exchanged(FLOW_XML, '    <dataSpace>default</dataSpace>\n', '');
    expect(getDataSpace(without)).to.equal(undefined);
    expect(() => setDataSpace(without, 'x'))
      .to.throw(FlowFileError)
      .with.property('code', 'FLOW_FILE_INVALID');
  });

  it('refuses text that is no flow file', () => {
    expect(() => assertFlowXml('<Other></Other>')).to.throw(FlowFileError);
    expect(() => assertFlowXml('<Flow><start></Flow>')).to.throw(FlowFileError);
    expect(() => assertFlowXml(FLOW_XML)).not.to.throw();
  });

  it('lists the contentId input values only', () => {
    expect(listContentIds(FLOW_XML)).to.deep.equal([
      'marketing--SourceWorkspace.sfdc_cms__email--Welcome',
      'marketing--SourceWorkspace.sfdc_cms__email--Reminder',
    ]);
  });

  it('replaces every contentId input value and nothing else', () => {
    const changed = replaceContentIds(FLOW_XML, (value) => value.replace('SourceWorkspace', 'Target'));
    expect(changed).to.equal(FLOW_XML.replaceAll('marketing--SourceWorkspace.', 'marketing--Target.'));
    expect(changed).to.include('marketing--Not.sfdc_cms__email--AContentId');
    expect(replaceContentIds(FLOW_XML, (value) => value)).to.equal(FLOW_XML);
  });

  it('names the files of a flow', () => {
    const paths = flowPaths('project', 'My_Flow');
    expect(paths.xml).to.equal(join('project', 'mcnext', 'flows', 'My_Flow.flow-meta.xml'));
    expect(paths.sidecar).to.equal(join('project', 'mcnext', 'flows', 'My_Flow.flow.json'));
    expect(apiNameOfFlowFile(paths.xml)).to.equal('My_Flow');
    expect(apiNameOfFlowFile(paths.sidecar)).to.equal(undefined);
    expect(sidecarPathOf(paths.xml)).to.equal(paths.sidecar);
  });
});

describe('flow sidecar', () => {
  it('round-trips campaign and needs', () => {
    const sidecar = {
      campaign: { name: 'Spring' },
      needs: [
        { kind: 'segment' as const, name: 'My_Segment', dataSpace: 'default' },
        { kind: 'content' as const, type: 'email', apiName: 'Welcome', workspace: 'SourceWorkspace' },
      ],
    };
    const text = serializeSidecar(sidecar);
    expect(text.endsWith('}\n')).to.equal(true);
    expect(text).not.to.include('\r');
    expect(parseSidecar(text)).to.deep.equal(sidecar);
  });

  it('reads a sidecar without campaign or needs', () => {
    expect(parseSidecar('{}')).to.deep.equal({ needs: [] });
  });

  it('refuses another shape', () => {
    for (const text of [
      '[',
      '[]',
      '{"campaign":"Spring"}',
      '{"needs":{}}',
      '{"needs":[{"kind":"segment","name":"x"}]}',
    ]) {
      expect(() => parseSidecar(text), text)
        .to.throw(FlowFileError)
        .with.property('code', 'FLOW_SIDECAR_INVALID');
    }
  });
});
