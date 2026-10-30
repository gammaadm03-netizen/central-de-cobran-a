export default function PayableColumnGuide() {
  return <details className="import-format-help"><summary>Como as colunas de Contas a Pagar são utilizadas</summary>
    <dl>
      <dt>Lançamento + Filial</dt><dd>Identificam o título nas próximas importações. Alterações de valor ou vencimento atualizam o mesmo lançamento.</dd>
      <dt>Histórico</dt><dd>Descrição da conta a pagar e da parcela.</dd>
      <dt>Plano cp - Conta: nome</dt><dd>Centro de custo da origem, vinculado ao Centro de Custo Macro. As classificações existentes são reaproveitadas; planos novos ficam como NÃO CLASSIFICADO para ajuste posterior.</dd>
      <dt>Plano cc - Conta: nome</dt><dd>Banco previsto no relatório. A informação fica preservada; o banco efetivo pode ser alterado na baixa dos títulos comuns.</dd>
      <dt>Emissão: valor do lançamento</dt><dd>Valor provisionado. O relatório mais recente atualiza o valor dos títulos em aberto.</dd>
      <dt>Emissão: data</dt><dd>Data de emissão do título.</dd>
      <dt>Vencimento: data</dt><dd>Vencimento atualizado pelo relatório mais recente.</dd>
      <dt>Cheque: número</dt><dd>Número do cheque, separado do lançamento. Todo título com número de cheque usa BRADESCO F2G como banco de pagamento.</dd>
    </dl><p className="help-text">Pagamentos já registrados permanecem no histórico. Títulos ausentes recebem o status Pago, sem criar pagamento financeiro; se voltarem a aparecer, a previsão será reaberta automaticamente.</p>
  </details>;
}
